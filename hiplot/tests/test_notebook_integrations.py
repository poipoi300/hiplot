"""Messages from the notebook front-end, and the values Streamlit returns before the first one."""

import builtins
import typing as t
from pathlib import Path

import IPython.display
import pytest

from .. import experiment as exp
from ..fetchers_demo import README_DEMOS
from ..ipython import GetSelectedFailure, IPythonExperimentDisplayed, NotebookJSBundleInjector
from ..streamlit_helpers import ExperimentStreamlitComponent


class FakeComm:
    def __init__(self) -> None:
        self.handler: t.Callable[[dict[str, t.Any]], None] | None = None

    def on_msg(self, handler: t.Callable[[dict[str, t.Any]], None]) -> None:
        self.handler = handler


class FakeCommManager:
    def __init__(self) -> None:
        self.targets: dict[str, t.Callable[[FakeComm, dict[str, t.Any]], None]] = {}

    def register_target(self, name: str, target: t.Callable[[FakeComm, dict[str, t.Any]], None]) -> None:
        self.targets[name] = target


class FakeIPython:
    def __init__(self) -> None:
        self.comm_manager = FakeCommManager()

    @property
    def kernel(self) -> "FakeIPython":
        return self


def test_selection_and_brushes_sent_by_the_front_end_are_returned(monkeypatch: pytest.MonkeyPatch) -> None:
    ipython = FakeIPython()
    monkeypatch.setattr(builtins, "get_ipython", lambda: ipython, raising=False)
    xp = README_DEMOS["demo"]()
    displayed = IPythonExperimentDisplayed(xp, "comm_test")
    with pytest.raises(GetSelectedFailure, match="No data received from the front-end"):
        displayed.get_selected()
    with pytest.raises(GetSelectedFailure, match="No data received from the front-end"):
        displayed.get_brush_extents()

    comm = FakeComm()
    ipython.comm_manager.targets["comm_test"](comm, {})
    assert comm.handler is not None
    chosen = [xp.datapoints[0].uid, xp.datapoints[3].uid]
    comm.handler({"content": {"data": {"type": "selected_uids", "data": chosen}}})
    comm.handler({"content": {"data": {"type": "brush_extents", "data": {"lr": {"range": [0, 1]}}}}})
    assert [dp.uid for dp in displayed.get_selected()] == chosen
    assert displayed.get_brush_extents() == {"lr": {"range": [0, 1]}}


def test_the_bundle_is_injected_as_javascript_exposing_a_global(monkeypatch: pytest.MonkeyPatch) -> None:
    displayed: list[t.Any] = []
    monkeypatch.setattr(IPython.display, "display", displayed.append)
    NotebookJSBundleInjector.ensure_injected()
    [injected] = displayed
    assert isinstance(injected, IPython.display.Javascript)
    bundle = (Path(exp.__file__).parent / "static" / "built" / "hiplot.bundle.js").read_text("utf-8")
    assert injected.data.lstrip().startswith(bundle.strip())
    assert injected.data.rstrip().endswith("Object.assign(window, {'hiplot': hiplot});")


def test_streamlit_defaults_select_every_row_until_the_front_end_answers() -> None:
    xp = exp.Experiment.from_iterable([{"uid": "a", "x": 1}, {"uid": "b", "x": 2}])
    get = ExperimentStreamlitComponent.get_default_return
    assert get(xp, None) is None
    assert get(xp, "selected_uids") == ("a", "b")
    assert get(xp, ["brush_extents", "filtered_uids"]) == ((), ("a", "b"))
    with pytest.raises(RuntimeError, match="Unknown return type"):
        get(xp, "nonsense")


def test_streamlit_components_without_a_key_warn_and_get_a_unique_one() -> None:
    xp = exp.Experiment.from_iterable([{"x": 1}])
    with pytest.warns(UserWarning, match="key=None"):
        component = ExperimentStreamlitComponent(xp, key=None, ret=["selected_uids"])
    assert component.js_ret_spec == ["selected_uids"]
    assert ExperimentStreamlitComponent(xp, key="k", ret=None).js_ret_spec == []


def test_an_experiment_needs_a_datapoint() -> None:
    with pytest.raises(exp.ExperimentValidationError, match="Not a single datapoint"):
        exp.Experiment().validate()
