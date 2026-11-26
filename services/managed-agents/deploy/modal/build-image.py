"""Build and publish the Modal sandbox image for the blue tool-sandbox provider.

Builds deploy/modal/Dockerfile (no amazon-efs-utils, tsflags=nocaps for
Modal's rootless builder) with the repo
root as build context, then publishes it as a named image so sandbox creation
never blocks on a rebuild. MODAL_DOCKERFILE and MODAL_CONTEXT_DIR build
another image the same way (an operator profile's, from an assembled context).

Requires `npm run build` first — the Dockerfile COPYs dist/.
Usage:
    modal token set --token-id ... --token-secret ...
    MODAL_APP_NAME=opencomputer-sandboxes MODAL_IMAGE_NAME=oc-blue-runtime \
        python deploy/modal/build-image.py
"""
import os
import time

import modal

APP_NAME = os.environ.get("MODAL_APP_NAME", "opencomputer-sandboxes")
IMAGE_NAME = os.environ.get("MODAL_IMAGE_NAME", "oc-blue-runtime")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DOCKERFILE = os.environ.get("MODAL_DOCKERFILE", os.path.join(HERE, "Dockerfile"))
CONTEXT_DIR = os.environ.get("MODAL_CONTEXT_DIR", REPO_ROOT)

app = modal.App.lookup(APP_NAME, create_if_missing=True)

image = modal.Image.from_dockerfile(DOCKERFILE, context_dir=CONTEXT_DIR)

t0 = time.time()
with modal.enable_output():
    built = image.build(app)
print(f"\nbuild: {time.time() - t0:.1f}s id={built.object_id}")

built.publish(IMAGE_NAME)
print(f"published: {IMAGE_NAME}")
