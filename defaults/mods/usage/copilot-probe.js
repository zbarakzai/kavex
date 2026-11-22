// Copilot's SDK uses Content-Length frames on stdio. Connect before asking only
// for quota, with the SDK's ping fallback for runtimes older than connect.
const FLAGS = "--headless --no-auto-update --stdio";
const CONNECT_SECONDS = 10;
const PING_SECONDS = 5;
const QUOTA_SECONDS = 10;
const MAX_REPLY_BYTES = 1_048_576;
const request = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const CONNECT = request(1, "connect", { supportedTaskKinds: ["agent", "client", "shell"] });
const PING = request(2, "ping");
const QUOTA = request(3, "account.getQuota");

// Run under LC_ALL=C so the frame length stays in bytes. Snapshot the file size
// before reading, as awk appends a newline to its final unterminated record.
const READ_FRAMES = String.raw`
{ buffer = buffer $0 "\n" }
END {
  buffer = substr(buffer, 1, size)
  while (match(buffer, /^\r?[Cc]ontent-[Ll]ength:[ \t]*[0-9]+/)) {
    header = substr(buffer, 1, RLENGTH)
    sub(/.*:[ \t]*/, "", header)
    bytes = header + 0
    first = index(buffer, "\r\n\r\n")
    if (!first || bytes <= 0 || bytes > maxBytes || length(buffer) < first + 3 + bytes) break
    body = substr(buffer, first + 4, bytes)
    buffer = substr(buffer, first + 4 + bytes)
    kind = responseKind(body)
    if (!kind) continue
    gsub(/[\r\n]/, "", body)
    print kind "\t" body
    break
  }
}
function responseKind(body, line, depth, token, same, method, kind) {
  line = body
  while (match(line, /"([^"\\]|\\.)*"|[][{}]/)) {
    token = substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)
    if (token == "{" || token == "[") depth++
    if (token == "}" || token == "]") depth--
    if (depth != 1 || line !~ /^[[:space:]]*:/) continue
    if (token == "\"id\"" && line ~ ("^[[:space:]]*:[[:space:]]*" id "[[:space:]]*[,}]")) same = 1
    if (token == "\"method\"") method = 1
    if (token == "\"result\"") kind = "result"
    if (token == "\"error\"") kind = "error"
  }
  if (depth != 0 || !same || method) return ""
  if (kind == "error" && (body ~ /"code"[[:space:]]*:[[:space:]]*-32601[[:space:]]*[,}]/ ||
                        body ~ /"message"[[:space:]]*:[[:space:]]*"Unhandled method connect"/)) return "missing"
  return kind
}`;

export function copilotPosix(program) {
  return `
export LC_ALL=C
work=$(mktemp -d) || exit 1
server=
cleanup() {
  exec 3>&-
  if [ -n "$server" ]; then
    for n in 1 2 3 4 5; do
      kill -0 "$server" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$server" 2>/dev/null; then kill -KILL "$server" 2>/dev/null || :; fi
    wait "$server" 2>/dev/null || :
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkfifo "$work/input" || exit 1
: >"$work/output"
${program} ${FLAGS} <"$work/input" >"$work/output" 2>/dev/null &
server=$!
exec 3>"$work/input"
send() { printf 'Content-Length: %s\\r\\n\\r\\n%s' "\${#1}" "$1" >&3; }
wait_for() {
  while [ "$2" -gt 0 ]; do
    size=$(wc -c <"$work/output")
    [ "$size" -le ${MAX_REPLY_BYTES} ] || return 1
    answer=$(awk -v size="$size" -v maxBytes=${MAX_REPLY_BYTES} -v id="$1" '${READ_FRAMES}' "$work/output")
    if [ -n "$answer" ]; then printf '%s\\n' "$answer"; return; fi
    kill -0 "$server" 2>/dev/null || return 1
    sleep 0.2
    set -- "$1" "$(($2 - 1))"
  done
  return 1
}
kind() { printf '%s\\n' "$1" | cut -f 1; }
emit() { printf '%s\\n' "$1" | cut -f 2-; }
send '${CONNECT}' || exit 1
opening=$(wait_for 1 ${CONNECT_SECONDS * 5}) || exit 1
emit "$opening"
if [ "$(kind "$opening")" = missing ]; then
  send '${PING}' || exit 1
  opening=$(wait_for 2 ${PING_SECONDS * 5}) || exit 1
  emit "$opening"
fi
[ "$(kind "$opening")" = result ] || exit 0
send '${QUOTA}' || exit 1
reply=$(wait_for 3 ${QUOTA_SECONDS * 5}) || exit 1
emit "$reply"`;
}

export function copilotPowershell(program) {
  return `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding $false
# .NET Framework lacks StandardInputEncoding and inherits the console encoding.
# A UTF-8 preamble before Content-Length makes the server reject the first frame.
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$go = New-Object Diagnostics.ProcessStartInfo
$go.FileName = $env:ComSpec
$go.Arguments = '/d /c ""' + ${program} + '" ${FLAGS} 2>nul"'
$go.UseShellExecute = $false
$go.CreateNoWindow = $true
$go.RedirectStandardInput = $true
$go.RedirectStandardOutput = $true
if ($go.PSObject.Properties['StandardInputEncoding']) { $go.StandardInputEncoding = $utf8 }
$server = [Diagnostics.Process]::Start($go)
$writer = $server.StandardInput.BaseStream
$reader = $server.StandardOutput.BaseStream
function Send-Request([string]$message) {
  $body = $utf8.GetBytes($message)
  $newline = [string][char]13 + [char]10
  $header = $utf8.GetBytes('Content-Length: ' + $body.Length + $newline + $newline)
  $writer.Write($header, 0, $header.Length)
  $writer.Write($body, 0, $body.Length)
  $writer.Flush()
}
function Read-Bytes([int]$count, $clock, [int]$deadline) {
  $bytes = New-Object byte[] $count
  $offset = 0
  while ($offset -lt $count) {
    $left = $deadline - [int]$clock.ElapsedMilliseconds
    if ($left -le 0) { throw 'Copilot reply timed out' }
    $next = $reader.ReadAsync($bytes, $offset, $count - $offset)
    if (-not $next.Wait($left) -or $next.Result -eq 0) { throw 'Copilot reply unavailable' }
    $offset += $next.Result
  }
  return ,$bytes
}
function Read-Reply([int]$id, [int]$deadline) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $newline = [string][char]13 + [char]10
  while ($clock.ElapsedMilliseconds -lt $deadline) {
    $header = ''
    do {
      if ($header.Length -ge 4096) { throw 'Copilot returned an invalid frame header' }
      $byte = Read-Bytes 1 $clock $deadline
      $header += [char]($byte[0])
    } until ($header.EndsWith($newline + $newline))
    if ($header -notmatch '(?im)^Content-Length:[ \\t]*(\\d+)') { throw 'Copilot omitted frame length' }
    $size = [int]$Matches[1]
    if ($size -le 0 -or $size -gt ${MAX_REPLY_BYTES}) { throw 'Copilot returned an invalid frame length' }
    $body = $utf8.GetString((Read-Bytes $size $clock $deadline))
    try { $message = ConvertFrom-Json -InputObject $body } catch { continue }
    if ($message.id -eq $id -and -not $message.PSObject.Properties['method'] -and
        ($message.PSObject.Properties['result'] -or $message.PSObject.Properties['error'])) {
      return @{ Message = $message; Body = $body.Replace([string][char]13, '').Replace([string][char]10, '') }
    }
  }
  throw 'Copilot reply timed out'
}
try {
  Send-Request '${CONNECT}'
  $opening = Read-Reply 1 ${CONNECT_SECONDS * 1000}
  [Console]::Out.WriteLine($opening.Body)
  if ($opening.Message.error.code -eq -32601 -or $opening.Message.error.message -eq 'Unhandled method connect') {
    Send-Request '${PING}'
    $opening = Read-Reply 2 ${PING_SECONDS * 1000}
    [Console]::Out.WriteLine($opening.Body)
  }
  if ($opening.Message.PSObject.Properties['result']) {
    Send-Request '${QUOTA}'
    $reply = Read-Reply 3 ${QUOTA_SECONDS * 1000}
    [Console]::Out.WriteLine($reply.Body)
  }
} finally {
  $server.StandardInput.Close()
  if (-not $server.WaitForExit(500)) { $server.Kill() }
  $server.Dispose()
}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quotaReplies(output) {
  const answers = new Map();
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (Number.isInteger(message?.id) && !("method" in message)) answers.set(message.id, message);
    } catch {}
  }
  return answers;
}

const quotaLabels = {
  premium_interactions: "Premium interactions",
  completions: "Completions",
  chat: "Chat",
};

function copilotLimits(snapshots, now) {
  const limits = [];
  for (const [key, snapshot] of Object.entries(snapshots)) {
    if (!isRecord(snapshot) || snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1) continue;
    // Zero entitlement cannot produce a meaningful percentage.
    if (snapshot.entitlementRequests === 0) continue;
    const remaining = snapshot.remainingPercentage;
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) continue;
    // Some headless builds put the cached observation time in resetDate.
    const resetsAt = typeof snapshot.resetDate === "string" ? Date.parse(snapshot.resetDate) : NaN;
    const label = Object.hasOwn(quotaLabels, key) ? quotaLabels[key] : key.replaceAll("_", " ");
    limits.push({ key, label, used: Math.round(100 - remaining), resetsAt: resetsAt > now ? resetsAt : null });
  }
  return limits;
}

export async function readCopilot({ runScript, now = Date.now, env }) {
  if (await env?.("COPILOT_PROVIDER_BASE_URL")) {
    return { limits: [], state: "unavailable", error: "Copilot is using a custom model provider." };
  }
  const unavailable = { limits: [], state: "unavailable", error: "Update Copilot CLI to a version that reports account quota." };
  if (!runScript) return unavailable;
  const result = await runScript(copilotPosix, copilotPowershell);
  const answers = quotaReplies(result.stdout);
  const quota = answers.get(3), error = (quota ?? answers.get(2) ?? answers.get(1))?.error;
  if (error?.code === -32601 || /unhandled method account.getQuota/i.test(error?.message ?? "")) return unavailable;
  if (/\b(?:not (?:signed|logged) in|not authenticated|authentication required)\b/i.test(error?.message ?? "")) return null;
  const snapshots = quota?.result?.quotaSnapshots;
  if (!isRecord(snapshots)) return { limits: [], state: "error", error: "Copilot CLI did not return account quota." };
  const limits = copilotLimits(snapshots, now());
  return limits.length
    ? { limits }
    : { limits: [], state: "unavailable", error: "Copilot did not report a finite allowance for this account." };
}
