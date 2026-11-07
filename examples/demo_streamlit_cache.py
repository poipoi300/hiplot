# Copyright (c) Facebook, Inc. and its affiliates.
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

# Run with `streamlit run examples/demo_streamlit_cache.py`
# DEMO_STREAMLIT_BEGIN
import hiplot.fetchers_demo
import streamlit as st
from hiplot.streamlit_helpers import ExperimentStreamlitComponent

x1, x2, x3 = st.slider("x1"), st.slider("x2"), st.slider("x3")


@st.cache_resource
def get_experiment() -> ExperimentStreamlitComponent:
    # We create a large experiment with 1000 rows
    big_exp = hiplot.fetchers_demo.demo(1000)
    # EXPERIMENTAL: Reduces bandwidth at first load
    big_exp._compress = True
    # ... convert it to streamlit and cache that (`@st.cache_resource` decorator)
    return big_exp.to_streamlit(key="hiplot")


xp = get_experiment()  # This will be cached the second time
xp.display()
