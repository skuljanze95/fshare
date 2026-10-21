# Records docs/demo.gif for the README with VHS (https://github.com/charmbracelet/vhs).
#
#   brew install vhs        # also installs ttyd and ffmpeg
#   vhs docs/demo.tape
#
# Then reference the GIF in README.md (see the comment at the top of the README).

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1300
Set Height 650
Set Padding 24
Set TypingSpeed 40ms

Hide
Type "cd $(mktemp -d) && echo 'Quarterly numbers' > report.pdf && clear" Enter
Show

Type "npx -y @skuljanze95/fshare share ./report.pdf --detach --expires 30m" Sleep 500ms Enter
Sleep 12s

Type "npx -y @skuljanze95/fshare list" Sleep 500ms Enter
Sleep 3s

Type "npx -y @skuljanze95/fshare stop --all" Sleep 500ms Enter
Sleep 3s
