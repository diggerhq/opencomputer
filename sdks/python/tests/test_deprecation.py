import importlib
import sys
import warnings

import pytest


def _fresh_import():
    for name in [m for m in sys.modules if m == "opencomputer" or m.startswith("opencomputer.")]:
        del sys.modules[name]
    return importlib.import_module("opencomputer")


def test_import_warns_deprecated_and_points_to_replacement():
    with pytest.warns(FutureWarning, match="deprecated") as record:
        mod = _fresh_import()
    message = str(record[0].message)
    assert "@opencomputer/sdk/agents" in message
    assert "https://opencomputer.dev/agents/api" in message
    assert mod.DEPRECATION_MESSAGE == message


def test_final_release_version_stays_on_major_1():
    # The server routes on the SDK's major (x-oc-sdk-version); the deprecation
    # release must not move callers.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        mod = _fresh_import()
    assert mod.__version__ == "1.2.0"


def test_existing_exports_still_import():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FutureWarning)
        mod = _fresh_import()
    for name in mod.__all__:
        assert hasattr(mod, name), name
