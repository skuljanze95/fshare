# Records docs/demo.gif for the README with VHS (https://github.com/charmbracelet/vhs).
#
#   brew install vhs        # also installs ttyd and ffmpeg
#   npm run build
#   vhs docs/demo.tape
#
# The demo runs this checkout's build as `fshare` and opens a real Cloudflare quick tunnel,
# so it needs cloudflared and a network connection.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1300
Set Height 400
Set Padding 24
Set TypingSpeed 45ms

Hide
Type `ROOT=$PWD && fshare() { node "$ROOT/dist/cli.js" "$@"; } && export FSHARE_HOME=$(mktemp -d) && cd $(mktemp -d) && head -c 2400000 /dev/urandom > report.pdf && clear` Enter
Sleep 500ms
Show

Type "fshare share ./report.pdf --detach --expires 30m" Sleep 500ms Enter
Sleep 13s

Type "fshare list" Sleep 500ms Enter
Sleep 3s

Type "fshare stop --all" Sleep 500ms Enter
Sleep 4s
