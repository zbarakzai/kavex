// The mod's exec API takes a command and returns when it exits. Keep Codex's
// stdin open in that command, and give startup and the requests separate deadlines.
const REQUESTS = [
  { id: 1, method: "initialize", params: { clientInfo: { name: "kavex", version: "1" } } },
  { method: "initialized", params: {} },
  { id: 2, method: "account/read", params: {} },
  { id: 3, method: "account/rateLimits/read", params: {} },
].map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }));

const FLAGS = "-c approval_policy=never -c features.plugins=false -s read-only -a never app-server";
const START_SECS = 16;
const READ_SECS = 10;

// Read only the top-level routing fields of each complete line. Nested IDs,
// server requests and notifications must not end a wait. The mod decodes the results.
const ENVELOPE = String.raw`
{
  line = $0
  depth = 0
  same = request = 0
  kind = ""
  while (match(line, /"([^"\\]|\\.)*"|[][{}]/)) {
    token = substr(line, RSTART, RLENGTH)
    line = substr(line, RSTART + RLENGTH)
    if (token == "{" || token == "[") depth++
    if (token == "}" || token == "]") depth--
    if (depth != 1 || line !~ /^[[:space:]]*:/) continue
    if (token == "\"id\"" && line ~ ("^[[:space:]]*:[[:space:]]*" id "[[:space:]]*[,}]")) same = 1
    if (token == "\"method\"") request = 1
    if (token == "\"result\"") kind = "result"
    if (token == "\"error\"") kind = "error"
  }
  if (depth == 0 && same && !request && kind != "") { print kind; exit }
}`;

const quoted = (messages) => messages.map((line) => `'${line}'`).join(" ");

export const codexPosix = (program) => `
work=$(mktemp -d) || exit 1
server=
cleanup() {
  exec 3>&-
  if [ -n "$server" ]; then
    # EOF lets npm shims and the server behind them both shut down.
    for i in 1 2 3 4 5; do
      kill -0 "$server" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$server" 2>/dev/null; then
      kill -KILL "$server" 2>/dev/null || :
    fi
    wait "$server" 2>/dev/null || :
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkfifo "$work/input" || exit 1
: > "$work/output"
${program} ${FLAGS} <"$work/input" >"$work/output" 2>/dev/null &
server=$!
exec 3>"$work/input"
reply() { awk -v id="$1" '${ENVELOPE}' "$work/output"; }
wait_for() {
  while [ "$1" -gt 0 ]; do
    [ -n "$(reply "$2")" ] && { [ -z "$3" ] || [ -n "$(reply "$3")" ]; } && return
    kill -0 "$server" 2>/dev/null || return 1
    sleep 0.2
    set -- "$(($1 - 1))" "$2" "$3"
  done
  return 1
}
printf '%s\\n' ${quoted(REQUESTS.slice(0, 1))} >&3 || exit 1
wait_for ${START_SECS * 5} 1 && [ "$(reply 1)" = result ] || exit 1
printf '%s\\n' ${quoted(REQUESTS.slice(1))} >&3 || exit 1
# Keep a confirmed account reply even if the rate-limit request stalls.
wait_for ${READ_SECS * 5} 2 3 || :
cat "$work/output"`;

// Windows PowerShell buffers ordinary pipe input until the whole pipeline ends.
// cmd also resolves npm's codex.cmd. The initial blank consumes a possible UTF-8 BOM.
export const codexPowershell = (program) => `
$ErrorActionPreference = 'Stop'
$go = New-Object Diagnostics.ProcessStartInfo
$go.FileName = $env:ComSpec
$go.Arguments = '/d /c ""' + ${program} + '" ${FLAGS} 2>nul"'
$go.UseShellExecute = $false
$go.CreateNoWindow = $true
$go.RedirectStandardInput = $true
$go.RedirectStandardOutput = $true
$go.StandardOutputEncoding = New-Object Text.UTF8Encoding $false
$server = [Diagnostics.Process]::Start($go)
function Send-Line($line) {
  $server.StandardInput.WriteLine($line)
  $server.StandardInput.Flush()
}
function Read-Reply($clock, $timeoutMs) {
  while (($left = $timeoutMs - [int]$clock.ElapsedMilliseconds) -gt 0) {
    $next = $server.StandardOutput.ReadLineAsync()
    if (-not $next.Wait($left) -or $null -eq $next.Result) { throw 'Codex response unavailable' }
    try { $message = ConvertFrom-Json -InputObject $next.Result } catch { continue }
    if ($null -ne $message.id -and -not $message.PSObject.Properties['method'] -and
        ($message.PSObject.Properties['result'] -or $message.PSObject.Properties['error'])) {
      return @{ message = $message; line = $next.Result }
    }
  }
  throw 'Codex response timed out'
}
try {
  $server.StandardInput.NewLine = [string][char]10
  Send-Line ''
  Send-Line '${REQUESTS[0]}'
  $clock = [Diagnostics.Stopwatch]::StartNew()
  do { $reply = Read-Reply $clock ${START_SECS * 1000} } until ($reply.message.id -eq 1)
  if (-not $reply.message.PSObject.Properties['result']) { throw 'Codex did not initialize' }
  [Console]::Out.WriteLine($reply.line)
  ${REQUESTS.slice(1).map((line) => `Send-Line '${line}'`).join("\n  ")}
  $clock.Restart()
  $pending = @(2, 3)
  while ($pending.Count -gt 0) {
    $reply = Read-Reply $clock ${READ_SECS * 1000}
    if ($reply.message.id -notin $pending) { continue }
    [Console]::Out.WriteLine($reply.line)
    $pending = @($pending | Where-Object { $_ -ne $reply.message.id })
  }
} finally {
  $server.StandardInput.Close()
  if (-not $server.WaitForExit(500)) { $server.Kill() }
  $server.Dispose()
}`;
