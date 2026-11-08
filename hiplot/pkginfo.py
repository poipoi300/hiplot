# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

from importlib.metadata import PackageNotFoundError, version

package_name = "hiplot-plus"

# Dynamic version from installed package metadata
# This ensures __version__ matches pyproject.toml when installed via pip
try:
    __version__ = version(package_name)
except PackageNotFoundError:
    # Package is not installed (e.g., running from source checkout)
    __version__ = "0.0.0.dev0"
