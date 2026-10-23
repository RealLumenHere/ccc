#!/bin/bash
# Launch CCC with the real desktop session environment, whether started from
# a terminal, SSH, or autostart. (2026-08-06)
XFPID=$(pgrep -x xfwm4 | head -1)
if [ -n "$XFPID" ]; then
  export $(tr "\0" "\n" < /proc/$XFPID/environ | grep -E "^(DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE|XDG_RUNTIME_DIR|PATH)=" | xargs -d "\n")
fi
cd /home/thor/claude-command-center
exec ./node_modules/.bin/electron . "$@"
