ZDOTDIR=$DASH_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
unset DASH_SHIM_DIR DASH_USER_ZDOTDIR

__dash_esc() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//;/\\x3b}
  s=${s//$'\n'/\\x0a}
  s=${s//$'\a'/}
  print -rn -- "$s"
}
__dash_preexec() { print -rn -- $'\e]633;E;'"$(__dash_esc "$1")"$'\a'; }
__dash_precmd() {
  local ec=$?
  print -rn -- $'\e]633;D;'$ec$'\a'$'\e]633;P;Cwd='"$(__dash_esc "$PWD")"$'\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __dash_preexec
precmd_functions=(__dash_precmd ${precmd_functions:#__dash_precmd})
