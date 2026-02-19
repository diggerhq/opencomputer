#!/bin/sh
set -e

# Fix cgroup v1 split controller directories on Fly.io VMs.
#
# Fly VMs mount cgroup v1 controllers as separate directories like
# "cpu,cpuacct" and "net_cls,net_prio". On standard Linux systems,
# "cpu" is a symlink to "cpu,cpuacct", but Fly creates "cpu" as
# a plain (empty) directory. This breaks podman/crun because they
# try to create cgroup paths under /sys/fs/cgroup/cpu/ which is
# not a real cgroup filesystem — just an empty tmpfs directory.
#
# Fix: replace the plain directories with symlinks to the real
# combined controller directories.

fix_cgroup_symlink() {
    local single="$1"    # e.g. "cpu"
    local combined="$2"  # e.g. "cpu,cpuacct"

    combined_path="/sys/fs/cgroup/${combined}"
    single_path="/sys/fs/cgroup/${single}"

    # Only fix if the combined path exists and the single path
    # is a directory (not already a symlink)
    if [ -d "$combined_path" ] && [ -d "$single_path" ] && [ ! -L "$single_path" ]; then
        echo "entrypoint: fixing cgroup symlink ${single} -> ${combined}"
        rm -rf "$single_path"
        ln -s "$combined_path" "$single_path"
    fi
}

# Fix known split cgroup v1 controllers
fix_cgroup_symlink "cpu" "cpu,cpuacct"
fix_cgroup_symlink "cpuacct" "cpu,cpuacct"
fix_cgroup_symlink "net_cls" "net_cls,net_prio"
fix_cgroup_symlink "net_prio" "net_cls,net_prio"

exec "$@"
