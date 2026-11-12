// The shell scripts behind the `/files` routes (workspace-files.ts): each is
// the whole of one operation, run by `/bin/sh -c <script> sh <root> <args…>`
// where the workspace's files are (work 103, C13). They need GNU coreutils,
// findutils and tar, which every computer and the session image have.
//
// Invariants:
// - `$1` is the workspace's root as the script's process sees it; what the
//   caller chose (a path, a name, a number) is `$2` and up. Nothing is ever
//   put into a script's text.
// - A script that takes a path resolves it first, symlinks included, and
//   acts on the resolved path only: exit 44 when it does not exist (or is not
//   the kind the operation reads), 45 when it leaves the workspace. Any other
//   non-zero exit is a fault.
// - `.git` is never descended into, archived or counted.

export const NOT_FOUND = 44;
export const OUTSIDE = 45;

/** `$abs`: the real path of `$2` under the real `$root`. */
const RESOLVE = `
root=$(realpath -e -- "$1" 2>/dev/null) || exit ${NOT_FOUND}
abs=$(realpath -e -- "$root/$2" 2>/dev/null) || exit ${NOT_FOUND}
case "$abs" in "$root"|"$root"/*) ;; *) exit ${OUTSIDE};; esac
`;

/**
 * `<path> <depth> <most>`: the entries of a directory down to `depth`, at most `most`, each
 * `type\tbytes\tmtime\tpath\0` (find's %y %s %T@ %P). A `.git` is listed and not entered; a directory that cannot
 * be read is listed and skipped.
 */
export const LIST = `${RESOLVE}
[ -d "$abs" ] || exit ${NOT_FOUND}
cd "$abs" || exit ${NOT_FOUND}
find . -mindepth 1 -maxdepth "$3" -printf '%y\\t%s\\t%T@\\t%P\\0' -name .git -prune 2>/dev/null | head -z -n "$4"
`;

/** `<path>`: a regular file's `size mtime inode` on one line, then its first 8192 bytes in base64 (nothing when it cannot be read). */
export const STAT = `${RESOLVE}
[ -f "$abs" ] || exit ${NOT_FOUND}
stat -c '%s %.3Y %i' -- "$abs" || exit 1
head -c 8192 -- "$abs" 2>/dev/null | base64 -w0
exit 0
`;

/** `<path>`: a regular file's bytes. */
export const CAT = `${RESOLVE}
[ -f "$abs" ] || exit ${NOT_FOUND}
exec cat -- "$abs"
`;

/** `<path> <most>`: `type bytes` for a directory and each entry under it, at most `most` lines; for anything else, one line for itself. */
export const COUNT = `${RESOLVE}
if [ -d "$abs" ]; then
  { echo 'd 0'; find "$abs" -mindepth 1 -name .git -prune -o -printf '%y %s\\n' 2>/dev/null; } | head -n "$3"
else
  stat -c 'f %s' -- "$abs"
fi
`;

/** `<path>`: a tar of a directory's contents, or of one file under its own name; owned by root, no mode a group or other can write. */
export const ARCHIVE = `${RESOLVE}
if [ -d "$abs" ]; then cd "$abs" || exit ${NOT_FOUND}; m=.; else cd "\${abs%/*}/" || exit ${NOT_FOUND}; m=\${abs##*/}; fi
exec tar -c --exclude=.git --owner=0 --group=0 --numeric-owner --mode=u+rw,go-w,a+rX -f - -- "$m"
`;

/** `<name>`: `exists` when the workspace has that name (a dangling link too), else `free`. */
export const CAN_UPLOAD = `if [ -e "$1/$2" ] || [ -L "$1/$2" ]; then echo exists; else echo free; fi`;

/** `<tmp>`: unpack the tar on standard input into a new directory `tmp` of the workspace. */
export const UNPACK = `mkdir -- "$1/$2" && exec tar -x --no-same-owner --no-same-permissions -C "$1/$2" -f -`;

/**
 * `<tmp> <name> <trash> <replace>`: `tmp` becomes `name`; with `replace`, what was there goes first. `-T`: never
 * into a directory that appeared meanwhile, so a name the agent created since the check fails here.
 */
export const MOVE_IN = `set -e; if [ -n "$5" ]; then mv -T -- "$1/$3" "$1/$4"; fi; mv -T -- "$1/$2" "$1/$3"; rm -rf -- "$1/$4"`;

/** `<name>`: remove it and everything in it. */
export const REMOVE = `rm -rf -- "$1/$2"`;
