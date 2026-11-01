//! Fetch document images with the creating script's policy. GPUI owns asynchronous
//! loading, caching and completion notifications; the document owns their lifetime.

use std::{
    collections::HashSet,
    io::Cursor,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use gpui::{
    App, Asset, Bounds, Element, ElementId, GlobalElementId, ImageCacheError, ImageSource,
    InspectorElementId, IntoElement, LayoutId, Pixels, RenderImage, SharedString, SharedUri,
    SvgRenderer, WeakEntity, Window, http_client::HttpClient,
};
use gpui_base::TextView;
use image::AnimationDecoder as _;
use smol::io::AsyncReadExt as _;

use crate::{Capabilities, capability::is_openable_url, policy::Policy};

const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;
const IMAGE_TIMEOUT: Duration = Duration::from_secs(30);

type ImageResult = Result<Arc<RenderImage>, ImageCacheError>;

// HERDR: `folder`, for a retained document's local images.
// HERDR: `folder` is where a document's relative images are.
pub(super) fn with_policy(
    view: TextView,
    policy: Rc<Policy>,
    folder: Option<PathBuf>,
) -> impl IntoElement {
    PolicyTextView {
        view,
        policy,
        folder,
    }
}

/// CLI check constructs elements without drawing. Only layout may initialize
/// the keyed image owner; GPUI's Asset still owns all loading and notifications.
struct PolicyTextView {
    view: TextView,
    policy: Rc<Policy>,
    // HERDR: where a retained document's relative images are.
    folder: Option<PathBuf>,
}

impl IntoElement for PolicyTextView {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for PolicyTextView {
    type RequestLayoutState = <TextView as Element>::RequestLayoutState;
    type PrepaintState = <TextView as Element>::PrepaintState;

    fn id(&self) -> Option<ElementId> {
        self.view.id()
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        self.view.source_location()
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        // HERDR: `folder`.
        self.view = image_sources(
            self.view.clone(),
            self.policy.clone(),
            self.folder.clone(),
            window,
            cx,
        );
        self.view.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.view
            .prepaint(id, inspector_id, bounds, state, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        self.view
            .paint(id, inspector_id, bounds, state, prepaint, window, cx);
    }
}

// HERDR: `folder`, as for `with_policy`.
fn image_sources(
    view: TextView,
    policy: Rc<Policy>,
    folder: Option<PathBuf>,
    window: &mut Window,
    cx: &mut App,
) -> TextView {
    let key = SharedString::from(format!(
        "{}/shell-images/{:p}",
        view.id().expect("TextView has an element id"),
        Rc::as_ptr(&policy),
    ));
    let images = window.use_keyed_state(key, cx, |_, cx| {
        let owner = cx.weak_entity();
        cx.on_release(move |images: &mut DocumentImages, cx| {
            for uri in &images.used {
                let source = (owner.clone(), uri.clone());
                if let Some(Ok(image)) = cx.fetch_asset::<DocumentImage>(&source) {
                    cx.drop_image(image, None);
                }
                cx.remove_asset::<DocumentImage>(&source);
            }
        })
        .detach();
        DocumentImages {
            policy,
            folder,
            used: HashSet::new(),
        }
    });
    view.image_source(move |uri| {
        let images = images.clone();
        let uri = uri.clone();
        ImageSource::Custom(Arc::new(move |window, cx| {
            images.update(cx, |images, _| {
                images.used.insert(uri.clone());
            });
            window.use_asset::<DocumentImage>(&(images.downgrade(), uri.clone()), cx)
        }))
    })
}

struct DocumentImages {
    // Retaining the immutable policy also keeps its identity from being reused.
    policy: Rc<Policy>,
    // HERDR: `folder`, as for `with_policy`.
    folder: Option<PathBuf>,
    used: HashSet<SharedUri>,
}

struct DocumentImage;

impl Asset for DocumentImage {
    // The owner scopes both successful and failed loads to this view and policy.
    // A weak reference lets releasing the view cancel pending loads.
    type Source = (WeakEntity<DocumentImages>, SharedUri);
    type Output = ImageResult;

    fn load(
        (owner, uri): Self::Source,
        cx: &mut App,
    ) -> impl Future<Output = ImageResult> + Send + 'static {
        // HERDR: local images read from the document's folder.
        let owned = owner.upgrade().map(|images| {
            let images = images.read(cx);
            (images.policy.capabilities().clone(), images.folder.clone())
        });
        let client = cx.http_client();
        let renderer = cx.svg_renderer();
        let timeout = cx.background_executor().timer(IMAGE_TIMEOUT);
        async move {
            let (capabilities, folder) = owned.ok_or_else(denied_image)?;
            if let Some(path) = folder.and_then(|folder| local_image(&folder, uri.as_ref())) {
                return decode_image(read_local_image(&path)?, renderer);
            }
            let url = image_url(&capabilities, uri.as_ref())?;
            smol::future::race(
                async move {
                    let bytes = request_image(client, capabilities, url).await?;
                    decode_image(bytes, renderer)
                },
                async move {
                    timeout.await;
                    Err(ImageCacheError::Asset(
                        "TextView image request timed out".into(),
                    ))
                },
            )
            .await
        }
    }
}

/// HERDR: where a document's image is on disk: relative to its folder, or a
/// `file:` link. Anything with another scheme is a URL's business.
fn local_image(folder: &Path, value: &str) -> Option<PathBuf> {
    if let Some((_, path)) = crate::markdown::file_url(value) {
        return Some(PathBuf::from(path));
    }
    let value = value.split(['#', '?']).next().unwrap_or(value);
    (!has_scheme(value)).then(|| folder.join(crate::markdown::percent_decoded(value)))
}

// HERDR: images from disk.
fn has_scheme(value: &str) -> bool {
    value.split_once(':').is_some_and(|(scheme, _)| {
        scheme.len() > 1
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    })
}

// HERDR: images from disk.
fn read_local_image(path: &Path) -> Result<Vec<u8>, ImageCacheError> {
    let failed = |error: std::io::Error| ImageCacheError::Asset(error.to_string().into());
    if std::fs::metadata(path).map_err(failed)?.len() > MAX_IMAGE_BYTES {
        return Err(ImageCacheError::Asset(
            "TextView image exceeds the size limit".into(),
        ));
    }
    std::fs::read(path).map_err(failed)
}

fn denied_image() -> ImageCacheError {
    ImageCacheError::Asset(
        "TextView images require an absolute HTTP(S) URL and a capabilities.network GET grant"
            .into(),
    )
}

fn image_url(capabilities: &Capabilities, value: &str) -> Result<reqwest::Url, ImageCacheError> {
    if !is_openable_url(value) {
        return Err(denied_image());
    }
    let url = reqwest::Url::parse(value).map_err(|_| denied_image())?;
    // Do not turn document-supplied userinfo into implicit HTTP credentials.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(denied_image());
    }
    if !capabilities.may_request(
        url.scheme(),
        url.host_str().unwrap_or_default(),
        url.port(),
        "GET",
        url.path(),
    ) {
        return Err(denied_image());
    }
    Ok(url)
}

async fn request_image(
    client: Arc<dyn HttpClient>,
    capabilities: Capabilities,
    mut url: reqwest::Url,
) -> Result<Vec<u8>, ImageCacheError> {
    for redirects in 0..=MAX_REDIRECTS {
        url = image_url(&capabilities, url.as_str())?;
        url.set_fragment(None);
        // The host transport must never follow a redirect on our behalf.
        let mut response = client.get(url.as_str(), ().into(), false).await?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if redirects == MAX_REDIRECTS {
                return Err(ImageCacheError::Asset(
                    "Too many TextView image redirects".into(),
                ));
            }
            let next = response
                .headers()
                .get("location")
                .and_then(|location| location.to_str().ok())
                .and_then(|location| url.join(location).ok())
                .ok_or_else(|| ImageCacheError::Asset("Invalid TextView image redirect".into()))?;
            if url.scheme() == "https" && next.scheme() == "http" {
                return Err(ImageCacheError::Asset(
                    "TextView image HTTPS downgrade refused".into(),
                ));
            }
            // The next iteration re-authorizes scheme, host, port, GET and path.
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(ImageCacheError::Asset(
                format!("TextView image request returned {}", response.status()).into(),
            ));
        }
        let mut bytes = Vec::new();
        response
            .body_mut()
            .take(MAX_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(ImageCacheError::Asset(
                "TextView image exceeds the 8 MiB limit".into(),
            ));
        }
        return Ok(bytes);
    }
    unreachable!("the final redirect is rejected above")
}

/// Match GPUI's resource decoding without handing it the document URL again.
/// Otherwise decoding would silently start a second, ungated HTTP request.
fn decode_image(bytes: Vec<u8>, renderer: SvgRenderer) -> ImageResult {
    let Ok(format) = image::guess_format(&bytes) else {
        refuse_svg_file_references(&bytes)?;
        return renderer
            .render_single_frame(&bytes, 1.0)
            .map_err(Into::into);
    };
    let frames = match format {
        image::ImageFormat::Gif => animation_frames(
            image::codecs::gif::GifDecoder::new(Cursor::new(&bytes))?.into_frames(),
        )?,
        image::ImageFormat::WebP => {
            let mut decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes))?;
            if decoder.has_animation() {
                let _ = decoder.set_background_color(image::Rgba([0, 0, 0, 0]));
                animation_frames(decoder.into_frames())?
            } else {
                static_frame(decoder)?
            }
        }
        _ => static_frame(
            image::ImageReader::with_format(Cursor::new(&bytes), format).into_decoder()?,
        )?,
    };
    Ok(Arc::new(RenderImage::new(frames)))
}

/// GPUI renders an SVG `<image>` whose href is not a data URL from the local
/// file it names, which would draw files the script has no grant to read.
/// Parse the SVG with a resolver that records such an href, and refuse the
/// image when it has one.
fn refuse_svg_file_references(bytes: &[u8]) -> Result<(), ImageCacheError> {
    let references_file = Arc::new(AtomicBool::new(false));
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new({
                let references_file = references_file.clone();
                move |_, _| {
                    references_file.store(true, Ordering::Relaxed);
                    None
                }
            }),
        },
        ..Default::default()
    };
    usvg::Tree::from_data(bytes, &options)
        .map_err(|error| ImageCacheError::Usvg(Arc::new(error)))?;
    if references_file.load(Ordering::Relaxed) {
        return Err(ImageCacheError::Asset(
            "TextView SVG images cannot reference files".into(),
        ));
    }
    Ok(())
}

fn static_frame(
    mut decoder: impl image::ImageDecoder,
) -> Result<smallvec::SmallVec<[image::Frame; 1]>, ImageCacheError> {
    let orientation = decoder.orientation()?;
    let mut image = image::DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    let mut data = image.into_rgba8();
    for pixel in data.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Ok(smallvec::smallvec![image::Frame::new(data)])
}

fn animation_frames(
    frames: image::Frames<'_>,
) -> Result<smallvec::SmallVec<[image::Frame; 1]>, ImageCacheError> {
    let mut decoded = smallvec::SmallVec::new();
    for frame in frames {
        match frame {
            Ok(mut frame) => {
                for pixel in frame.buffer_mut().chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                decoded.push(frame);
            }
            Err(error) => tracing::debug!(%error, "Skipping an invalid TextView image frame"),
        }
    }
    if decoded.is_empty() {
        return Err(ImageCacheError::Asset(
            "TextView image has no decodable frames".into(),
        ));
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests;
