# Dash: kích hoạt môi trường Python đã chọn cho dự án, chạy sau rc của người dùng (bash và zsh).
# DASH_PYENV = thư mục gốc của env, DASH_PYENV_KIND = venv | conda, DASH_CONDA_SH = conda.sh để nạp hàm conda.
if [ -n "$DASH_PYENV" ]; then
  if [ "$DASH_PYENV_KIND" = conda ]; then
    typeset -f conda >/dev/null 2>&1 || { [ -n "$DASH_CONDA_SH" ] && . "$DASH_CONDA_SH"; }
    conda activate "$DASH_PYENV" || printf 'dash: could not activate conda env %s\n' "$DASH_PYENV" >&2
  elif [ -f "$DASH_PYENV/bin/activate" ]; then
    . "$DASH_PYENV/bin/activate"
  fi
fi
unset DASH_PYENV DASH_PYENV_KIND DASH_CONDA_SH

# Env Python đang bật trong shell (venv, hoặc conda khác base); prompt báo cho Dash qua OSC 633 PyEnv=.
__dash_pyenv() {
  if [ -n "$VIRTUAL_ENV" ]; then
    printf '%s' "$VIRTUAL_ENV"
  elif [ -n "$CONDA_PREFIX" ] && [ "$CONDA_DEFAULT_ENV" != base ]; then
    printf '%s' "$CONDA_PREFIX"
  fi
}
