# Dash: nạp cấu hình zsh của người dùng, rồi thêm hook báo lệnh/thư mục cho Dash (OSC 633).
DASH_SHIM_DIR=$ZDOTDIR
ZDOTDIR=${DASH_USER_ZDOTDIR:-$HOME}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
DASH_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$DASH_SHIM_DIR
