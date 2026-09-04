"""The SDK's own identity, sent on the requests that decide which runtime serves
a customer: creating a sandbox and creating a template or snapshot.

This is what makes self-service migration possible. An org that has not been
pinned to a runtime lands on the MicroVM backend when it calls with a 1.x SDK
and on the QEMU fleet when it calls with an older one — so upgrading the
dependency IS the migration, and pinning the old version is the rollback.
Nothing has to change in our database for either direction.

Only the MAJOR is load-bearing: the server compares it against a minimum, so
patch and minor releases never move anyone.

1.0.0, not 2.0.0, even though the docs call this platform generation "v2": every
version this package has ever published is 0.x, so 1.0.0 is both the first
stable release and a clean major break from all of them. The product generation
and the package major are not the same number.

This file is the single source of truth for the version: pyproject.toml declares
it dynamic and hatch's version hook reads the assignment below, and CI reads the
same line to decide whether to publish. That is deliberate — a constant that
drifted from the published version would ship a release still announcing the old
one, leaving every customer who upgraded on the old runtime with no error
anywhere. Keep the assignment on one line, at column 0, and do not let prose in
this docstring start with that name: two readers of this file are greps.
"""

from __future__ import annotations

__version__ = "1.0.0"

#: Header carrying the version above. Lower-case to match the TypeScript SDK;
#: HTTP/2 requires it there and consistency costs nothing here.
SDK_VERSION_HEADER = "x-oc-sdk-version"


def sdk_version_headers() -> dict[str, str]:
    """The identifying header, ready to merge into a request's headers."""
    return {SDK_VERSION_HEADER: __version__}
