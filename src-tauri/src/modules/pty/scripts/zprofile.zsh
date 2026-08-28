# codev-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _codev_user_zdotdir="${CODEV_USER_ZDOTDIR:-$HOME}"
  [ -f "$_codev_user_zdotdir/.zprofile" ] && source "$_codev_user_zdotdir/.zprofile"
  unset _codev_user_zdotdir
}
:
