# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import sys

from .server import run_server_main

# Only ever executed by `python -m hiplot`, so it needs no __name__ guard.
sys.exit(run_server_main())
