/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import DataTable, { type Api, type ConfigColumns } from "datatables.net";
import $ from "jquery";
import React from "react";
import "datatables.net-bs5";

// Ensure jQuery is on window for DataTables modules
if (typeof window !== "undefined") {
  Object.assign(window, { $, jQuery: $ });
  DataTable.use($);
}

let dataTablesExtensionsPromise: Promise<void> | null = null;

function ensureDataTablesExtensions(): Promise<void> {
  if (dataTablesExtensionsPromise) {
    return dataTablesExtensionsPromise;
  }
  if (!$.fn.DataTable) {
    Object.assign($.fn, { DataTable, dataTable: DataTable });
  }
  dataTablesExtensionsPromise = import("datatables.net-buttons")
    .then(() => import("datatables.net-buttons-bs5"))
    .then(() => import("datatables.net-colreorder"))
    .then(() => import("datatables.net-colreorder-bs5"))
    .then(() => undefined);
  return dataTablesExtensionsPromise;
}

import _ from "underscore";
import { type Filter, FilterType } from "./filters";
import style from "./hiplot.module.css";
import { mounted } from "./lib/refs";
import type { HiPlotPluginData } from "./plugin";
import type { Datapoint, DatapointValue } from "./types";

type RowsDisplayTableState = Record<never, never>;

/** One table row: the color cell ("") followed by one value per column of `ordered_cols`. */
type TableRowData = Array<DatapointValue>;

// DISPLAYS_DATA_DOC_BEGIN
// Corresponds to values in the dict of `exp.display_data(hip.Displays.TABLE)`
export interface TableDisplayData {
  // Hidden columns, that won't appear in the table
  hide: Array<string>;

  // Default ordering of the rows in the table.
  // To order by `loss` for instance, set it to [['loss', 'desc']]
  order_by: Array<[string /* column name */, "asc" | "desc"]>;

  // Ordering of the columns
  order?: Array<string>;
}
// DISPLAYS_DATA_DOC_END

interface TablePluginProps extends HiPlotPluginData, TableDisplayData {}

export class RowsDisplayTable extends React.Component<TablePluginProps, RowsDisplayTableState> {
  table_ref = React.createRef<HTMLTableElement>();
  table_container = React.createRef<HTMLDivElement>();
  dt: Api<TableRowData> | null = null;
  ordered_cols: Array<string> = [];
  empty = true;

  setSelected_debounced = _.debounce(this.setSelected, 150);

  private getUidFromRowData(rowData: TableRowData): string {
    const uidIdx = this.ordered_cols.indexOf("uid");
    if (uidIdx >= 0) {
      const direct = String(rowData[uidIdx]);
      if (this.props.dp_lookup[direct] !== undefined) {
        return direct;
      }
      if (this.dt?.colReorder) {
        const reorderedUidIdx = this.dt.colReorder.order().indexOf(uidIdx);
        const remapped = String(rowData[reorderedUidIdx]);
        if (this.props.dp_lookup[remapped] !== undefined) {
          return remapped;
        }
      }
    }
    return String(rowData[uidIdx]);
  }

  static defaultProps: TableDisplayData = {
    hide: [],
    order_by: [["uid", "asc"]],
  };

  constructor(props: TablePluginProps) {
    super(props);
    this.state = {};
  }
  componentDidMount() {
    void this.mountDt();
  }
  async mountDt() {
    if (!this.props.params_def.uid) {
      return;
    }
    await ensureDataTablesExtensions();
    const dom = $(mounted(this.table_ref));
    this.ordered_cols = ["uid"];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const me = this;
    $.each(this.props.params_def, (k: string, _def) => {
      if (k === "uid") {
        return;
      }
      me.ordered_cols.push(k);
    });
    const columnOrder = me.props.order;
    if (columnOrder) {
      const columnOrderScore = (col: string) => {
        const index = columnOrder.indexOf(col);
        if (index === -1) {
          return columnOrder.length;
        }
        return index;
      };
      me.ordered_cols.sort((a, b) => {
        // Return negative if `a` comes first
        return columnOrderScore(a) - columnOrderScore(b);
      });
    }
    me.ordered_cols.unshift("");

    dom.empty();
    const columns: Array<ConfigColumns> = this.ordered_cols.map((x) => {
      const pd = me.props.params_def[x];
      return {
        title:
          x === ""
            ? ""
            : $("<span />").attr("class", pd.label_css).html(pd.label_html)[0].outerHTML,
        defaultContent: "null",
        type: x === "" ? "html" : pd.numeric ? "num" : "string",
        visible: !me.props.hide?.includes(x),
        orderable: x !== "", // Don't allow to sort by color
      };
    });
    const order_by = this.props.order_by.map((col_otype): [number, "asc" | "desc"] => {
      const col_idx = me.ordered_cols.indexOf(col_otype[0]);
      console.assert(
        col_idx >= 0,
        `TABLE: Column for ordering ${col_otype[0]} does not exist. Available columns: ${me.ordered_cols.join(",")}`,
      );
      return [col_idx, col_otype[1]];
    });
    columns[0].render = (_data: unknown, _type: unknown, row: TableRowData) => {
      if (!me.dt) {
        return "";
      }
      const uid = me.getUidFromRowData(row);
      const color = me.props.get_color_for_row(me.props.dp_lookup[uid], 1.0);
      return `<span class="${style.colorBlock}" style="background-color: ${color}" />`;
    };
    this.dt = dom.DataTable<TableRowData>({
      columns: columns,
      data: [],
      order: order_by,
      deferRender: true, // Create HTML elements only when displayed
      headerCallback: function headerCallback(thead: HTMLTableRowElement) {
        const contextMenuRef = me.props.context_menu_ref;
        Array.from(thead.cells).forEach((th: HTMLElement, _i) => {
          const col = th.textContent ?? "";
          if (col !== "" && me.dt === null && contextMenuRef !== undefined) {
            th.addEventListener("contextmenu", (e) => {
              mounted(contextMenuRef).show(e.pageX, e.pageY, col);
              e.preventDefault();
              e.stopPropagation();
            });
          }
        });
      },
      buttons: [
        {
          text: "Select results",
          className: "btn-sm btn-outline-primary d-none",
          action: this.setSelectedToSearchResult.bind(this),
        },
      ],
      colReorder: true,
    });
    dom.wrap('<div class="hiplot-table-scroll"></div>');
    const btnsContainer = $(mounted(this.table_container)).find(".col-md-6:eq(1)");
    btnsContainer.addClass("btn-group");
    this.dt.buttons().container().appendTo(btnsContainer);
    btnsContainer.find(".dt-buttons").removeClass("btn-group");
    dom.on(
      "search.dt",
      function (this: RowsDisplayTable) {
        if (!this.dt) {
          return;
        }
        const node = this.dt.buttons()[0].node;
        node.classList.remove("d-none");
        node.classList.remove("btn-secondary");
        const searchResults = this.dt.rows({ search: "applied" });
        if (this.dt.search() === "" || searchResults.count() === 0) {
          node.classList.add("d-none");
        }
      }.bind(this),
    );

    this.empty = true;
    dom
      .find("tbody")
      .on("mouseenter", "td", function () {
        if (!me.dt || me.empty) {
          return;
        }
        const rowIdx = me.dt.cell(this).index().row;
        const row = me.dt.row(rowIdx);

        dom.find(`.table-primary`).removeClass("table-primary");
        const rowNode = row.node();
        if (rowNode) {
          $(rowNode).addClass("table-primary");
        }
        me.props.setHighlighted([me.props.dp_lookup[me.getUidFromRowData(row.data())]]);
      })
      .on("mouseout", "td", function () {
        if (!me.dt || me.empty) {
          return;
        }
        const rowIdx = me.dt.cell(this).index().row;
        const rowNode = me.dt.row(rowIdx).node();
        if (rowNode) {
          $(rowNode).removeClass("table-primary");
        }
        me.props.setHighlighted([]);
      });

    me.setSelected(me.props.rows_selected);
  }
  componentDidUpdate(prevProps: HiPlotPluginData): void {
    /* Sometimes we need to redraw the entire table
     * but this is super expensive, so let's do it only if
     * strictly necessary
     * aka when changing `numeric` status of a column
     * or when we add/remove columns
     */
    let shouldRemountTable = false;
    if (prevProps.params_def !== this.props.params_def) {
      const k1: string[] = Object.keys(prevProps.params_def);
      const k2: string[] = Object.keys(this.props.params_def);
      k1.sort();
      k2.sort();
      if (k1.length !== k2.length) {
        shouldRemountTable = true;
      } else {
        for (let i = 0; i < k1.length; ++i) {
          if (
            k1[i] !== k2[i] ||
            prevProps.params_def[k1[i]].numeric !== this.props.params_def[k2[i]].numeric
          ) {
            shouldRemountTable = true;
            break;
          }
        }
      }
    }
    if (shouldRemountTable) {
      this.destroyDt();
      this.mountDt();
    } else if (
      // Rows changed
      prevProps.rows_selected !== this.props.rows_selected ||
      // Color changed - need redraw with the correct color
      prevProps.colorby !== this.props.colorby ||
      // Color scale changed - need redraw with the correct color
      prevProps.params_def !== this.props.params_def
    ) {
      this.setSelected_debounced(this.props.rows_selected);
    }
  }
  setSelectedToSearchResult() {
    const dt = this.dt;
    if (!dt) {
      return;
    }
    const searchResults = dt.rows({ search: "applied" });
    const uidIdx = this.ordered_cols.indexOf("uid");
    const searchResultsDatapoints: Array<Datapoint> = searchResults
      .data()
      .toArray()
      .map((row: TableRowData) => this.props.dp_lookup[String(row[uidIdx])]);
    const searchTerm = dt.search();
    if (typeof searchTerm !== "string") {
      throw new Error("The table search box only produces string searches");
    }
    let filter: Filter = {
      type: FilterType.Search,
      data: searchTerm,
    };
    if (this.props.rows_selected_filter) {
      filter = {
        type: FilterType.All,
        data: [this.props.rows_selected_filter, filter],
      };
    }
    this.props.setSelected(searchResultsDatapoints, filter);
  }
  setSelected(selected: Array<Datapoint>) {
    const dt = this.dt;
    if (!dt) {
      return;
    }
    const ordered_cols = this.ordered_cols;

    dt.clear();
    dt.rows.add(selected.map((row) => ordered_cols.map((col) => (col === "" ? "" : row[col]))));
    if (dt.search() === "") {
      // Hack to redraw faster
      dt.settings()[0].oFeatures.bFilter = false;
      dt.draw();
      dt.settings()[0].oFeatures.bFilter = true;
    } else {
      dt.draw();
    }
    this.empty = selected.length === 0;
  }
  render() {
    return (
      <div className={`${style.wrap} container-fluid ${style["horizontal-scrollable"]}`}>
        <div className={"row"}>
          <div
            ref={this.table_container}
            className={`col-md-12 sample-table-container ${style.tableContainer}`}
          >
            <table
              ref={this.table_ref}
              className="table-hover table-sm sample-rows-table display table-striped table-bordered dataTable"
            ></table>
          </div>
        </div>
      </div>
    );
  }
  destroyDt() {
    if (this.dt) {
      const dt = this.dt;
      this.dt = null;
      dt.destroy();
    }
  }
  componentWillUnmount() {
    this.destroyDt();
    this.setSelected_debounced.cancel();
  }
}
