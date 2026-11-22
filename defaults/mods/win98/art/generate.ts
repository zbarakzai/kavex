import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]??'/var/tmp/herdr98'),base=`${root}/mods/win98`,art=`${root}/art`;
mkdirSync(art,{recursive:true});
for(const d of ['icons','img','sounds']) mkdirSync(`${base}/${d}`,{recursive:true});
const P: Record<string,string>={K:'#000000',W:'#ffffff',s:'#808080',l:'#dfdfdf',c:'#c0c0c0',n:'#000080',b:'#0000ff',a:'#008080',t:'#00ffff',g:'#008000',G:'#00ff00',r:'#800000',R:'#ff0000',y:'#808000',Y:'#ffff00',p:'#800080',f:'#ffffc0',e:'#c8c0a0',d:'#808060'};
class Pix {
 w:number; h:number; a:string[][];
 constructor(w:number,h=w){this.w=w;this.h=h;this.a=Array.from({length:h},()=>Array(w).fill(''));}
 dot(x:number,y:number,c:string){x=Math.round(x);y=Math.round(y);if(x>=0&&y>=0&&x<this.w&&y<this.h)this.a[y][x]=c;}
 rect(x:number,y:number,w:number,h:number,c:string){for(let j=Math.round(y);j<Math.round(y+h);j++)for(let i=Math.round(x);i<Math.round(x+w);i++)this.dot(i,j,c);}
 line(x:number,y:number,x2:number,y2:number,c:string,t=1){const n=Math.max(Math.abs(x2-x),Math.abs(y2-y));for(let i=0;i<=n;i++)this.rect(Math.round(x+(x2-x)*i/(n||1)),Math.round(y+(y2-y)*i/(n||1)),t,t,c);}
 poly(pts:number[][],c:string){for(let y=0;y<this.h;y++)for(let x=0;x<this.w;x++){let hit=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const [xi,yi]=pts[i],[xj,yj]=pts[j];if((yi>y)!=(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)hit=!hit;}if(hit)this.dot(x,y,c);}}
 svg(tint=false){let r='';for(let y=0;y<this.h;y++){for(let x=0;x<this.w;){const c=this.a[y][x];let z=x+1;while(z<this.w&&this.a[y][z]===c)z++;if(c)r+=`<rect x="${x}" y="${y}" width="${z-x}" height="1" fill="${tint?'currentColor':P[c]||c.slice(0,7)}"${c.startsWith('#')&&c.length===9?` fill-opacity="${parseInt(c.slice(7),16)/255}"`:''}/>`;x=z;}}return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}" shape-rendering="crispEdges">${r}</svg>`;}
}
const mark32=['.............KK..............','.............KKKK............','............KKKKKK...........','............KKKKKK...........','...........KKKKKK............','.............KKK.............','.................KK..........','................KKKK.........','...............KKKKKK........','..............KKKKKKKK.......','.............KKKKKKKKKKK.....','..............KKKKKKKKKKK....','...............KKKKKKKKKKKK..','.................KKKKKKKKKKK.','...................KKKKKKKKK.','.....................KKKKKKKK','.......................KKKKKK','........................KKKKK','........................KKKKK','........................KKKKK','.......................KKKKK.','.......KKKKKKKKKK..KKKKKKKKK.','.....KKKKKKKKKKKKKKKKKKKKKK..','...KKKKKKKKKKKKKKKKKKKKKKK...','..KKKKKKKKKKKKKKKKKKKKKKK....','.KKKKKKKKKKKKKKKKKKKKKK......','.KKK..........KKKKKK.........','K............................'];
// The checked-in Heroicons SVGs are also the source for a generated layout.
const sourceIcons = fileURLToPath(new URL('../icons', import.meta.url));
const outputIcons = `${base}/icons`;
if (sourceIcons !== outputIcons) cpSync(sourceIcons, outputIcons, { recursive: true });

function cmd(args:string[]){const s=spawnSync('magick',args,{stdio:'inherit'});if(s.status)throw Error('magick failed');}
const regular=fileURLToPath(new URL('../fonts/PixelatedMSSansSerif-Regular.ttf',import.meta.url)),bold=fileURLToPath(new URL('../fonts/PixelatedMSSansSerif-Bold.ttf',import.meta.url));
// Pixel lettering is rendered before rotation so the banner remains sharp.
cmd(['-size','110x21','xc:none','+antialias','-font',bold,'-pointsize','16','-fill','white','-annotate','+2+17','Kavex','-font',regular,'-fill','#dfdfdf','-annotate','+59+17','98','-rotate','-90',`${base}/img/banner.png`]);
cmd([`${base}/img/banner.png`,'-filter','point','-resize','200%',`${base}/img/banner@2x.png`]);
const largeLogo=new Pix(48,32);for(let j=0;j<mark32.length;j++)for(let i=0;i<mark32[j].length;i++)if(mark32[j][i]==='K')largeLogo.dot(i+18,j+2,'K');for(const[x,y,c]of [[0,9,'R'],[6,6,'R'],[12,3,'G'],[3,17,'b'],[9,14,'b'],[14,11,'G'],[0,25,'b'],[7,23,'Y'],[13,21,'Y']]as const)largeLogo.rect(x,y,4,4,c);writeFileSync(`${art}/logo.svg`,largeLogo.svg());
cmd(['-size','356x80','gradient:white-#a4d2ee','(','+size','-background','none',`${art}/logo.svg`,'-filter','point','-resize','96x64',')','-geometry','+12+8','-composite','+antialias','-font',bold,'-pointsize','32','-fill','black','-annotate','+117+51','Kavex','-font',regular,'-pointsize','32','-annotate','+241+51','98',`${base}/img/about.png`]);
// Seeded low-frequency fractal noise supplies a soft cloud bank, with no downloaded artwork.
cmd(['-seed','98','-size','640x400','plasma:fractal','-colorspace','gray','-blur','0x6','-auto-level','-level','8%,80%','-colorspace','sRGB','+level-colors','#4b94d3,#ffffff','-resize','1280x800',`${base}/img/clouds.png`]);
cmd([`${base}/img/clouds.png`,'-resize','640x480!','(','-background','none',`${art}/logo.svg`,'-filter','point','-resize','240x160',')','-geometry','+67+114','-compose','over','-composite','+antialias','-font',bold,'-pointsize','48','-fill','black','-annotate','+325+200','Kavex','-font',regular,'-pointsize','72','-annotate','+350+275','98',`${base}/img/splash.png`]);
const mon=new Pix(184,170);mon.poly([[6,5],[177,5],[182,11],[182,137],[173,144],[11,144],[2,135],[2,13]],'K');mon.rect(4,8,175,130,'e');mon.line(5,8,176,8,'W');mon.line(4,8,4,134,'W');mon.line(179,12,179,136,'s',2);mon.rect(13,12,160,121,'s');mon.rect(15,14,156,117,'K');mon.rect(17,16,153,113,'');mon.rect(60,144,64,15,'s');mon.poly([[48,156],[132,156],[147,166],[144,169],[38,169],[36,166]],'K');mon.poly([[49,157],[131,157],[141,165],[41,165]],'e');mon.line(43,166,139,166,'s');mon.rect(152,136,12,3,'s');mon.rect(168,136,3,3,'G');writeFileSync(`${art}/monitor.svg`,mon.svg());cmd(['-background','none',`${art}/monitor.svg`,`${base}/img/monitor.png`]);
writeFileSync(`${base}/img/clippy.svg`,`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80"><path d="M5 51L52 48 59 74 12 78Z" fill="#ffffa0" stroke="#808000"/><path d="M13 59L49 56M15 64L51 61M17 69L53 66" stroke="#b8b889"/><path d="M24 57C15 58 11 49 13 36L17 17C19 4 40 3 44 14C47 23 40 49 38 56C35 66 23 65 22 55L27 25C28 18 36 18 36 25L31 48" fill="none" stroke="#4c4c4c" stroke-width="6" stroke-linecap="round"/><path d="M24 57C15 58 11 49 13 36L17 17C19 4 40 3 44 14C47 23 40 49 38 56C35 66 23 65 22 55L27 25C28 18 36 18 36 25L31 48" fill="none" stroke="#d0d0d0" stroke-width="3" stroke-linecap="round"/><path d="M24 57C16 56 14 49 15 39L19 18M24 11C33 5 42 10 43 17M24 55L29 25" fill="none" stroke="white" stroke-width="1"/><ellipse cx="25" cy="23" rx="9" ry="11" fill="white" stroke="#444"/><ellipse cx="42" cy="24" rx="9" ry="11" fill="white" stroke="#444"/><ellipse cx="22" cy="20" rx="3" ry="4"/><ellipse cx="39" cy="21" rx="3" ry="4"/><path d="M17 10Q24 5 30 9M36 10Q43 7 49 13" fill="none" stroke="#222" stroke-width="2.5" stroke-linecap="round"/></svg>`);
console.log('Generated icons and images.');
