/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import DataTable, { type Api, type ConfigColumns } from "datatables.net";
import $ from "jquery";
import React from "react";
import _ from "underscore";
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

import {
  type ColumnCondition,
  columnConditionHolds,
  type Filter,
  FilterType,
  parseColumnCondition,
} from "./filters";
import style from "./hiplot.module.css";
import controls from "./lib/controls.module.css";
import { formatTableNumber } from "./lib/numberformat";
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

/** Name of the DataTables search that applies the per-column filters. */
const COLUMN_FILTERS_SEARCH = "hiplot-column-filters";
const FILTER_HINT = "Text to find, or a condition: >0.5, <=1e-3, =3, 0.1..0.5";

/** Pagination arrows, drawn rather than typed. */
const chevrons = (path: string): string =>
  `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const PAGING_LABELS = {
  first: chevrons("M9.5 3 6.5 6l3 3M5.5 3 2.5 6l3 3"),
  previous: chevrons("M7.5 3 4.5 6l3 3"),
  next: chevrons("M4.5 3l3 3-3 3"),
  last: chevrons("M2.5 3l3 3-3 3M6.5 3l3 3-3 3"),
};

export class RowsDisplayTable extends React.Component<TablePluginProps, RowsDisplayTableState> {
  table_ref = React.createRef<HTMLTableElement>();
  table_container = React.createRef<HTMLDivElement>();
  dt: Api<TableRowData> | null = null;
  ordered_cols: Array<string> = [];
  empty = true;
  /** The text typed in each column's filter, by column name. */
  columnQueries = new Map<string, string>();

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
  /** The conditions of the column filters that are not blank. */
  columnConditions(): Array<[string, ColumnCondition]> {
    const conditions: Array<[string, ColumnCondition]> = [];
    this.columnQueries.forEach((query, column) => {
      const condition = parseColumnCondition(query);
      if (condition !== null) {
        conditions.push([column, condition]);
      }
    });
    return conditions;
  }
  /** Whether the global search or a column filter narrows the rows down. */
  isSearching(): boolean {
    return (this.dt !== null && this.dt.search() !== "") || this.columnConditions().length > 0;
  }
  /** Re-applies the column filters after one was edited. */
  applyColumnFilters = _.debounce((): void => {
    const dt = this.dt;
    if (dt === null) {
      return;
    }
    const conditions = this.columnConditions();
    dt.search.fixed(
      COLUMN_FILTERS_SEARCH,
      conditions.length === 0
        ? null
        : (_data: string, rowData: TableRowData) => {
            const row = this.props.dp_lookup[this.getUidFromRowData(rowData)];
            return conditions.every(([column, condition]) =>
              columnConditionHolds(condition, row[column]),
            );
          },
    );
    dt.draw();
    this.updateSelectResultsButton();
  }, 150);
  /** The filter input of one column, in the header row under the titles. */
  filterInput(column: string): JQuery<HTMLInputElement> {
    const input = $<HTMLInputElement>('<input type="text" autocomplete="off" spellcheck="false">')
      .addClass("hiplot-column-filter")
      .attr("placeholder", "Filter")
      .attr("aria-label", `Filter ${column}`)
      .attr("title", FILTER_HINT);
    // The header sorts on click; typing in a filter must not.
    input.on("click mousedown keydown", (event) => event.stopPropagation());
    input.on("input", () => {
      this.columnQueries.set(column, String(input.val()));
      this.applyColumnFilters();
    });
    return input;
  }
  /** Shows the sort priority on every sorted column once more than one is. */
  markOrderPriorities(): void {
    const dt = this.dt;
    if (dt === null) {
      return;
    }
    const order = dt.order();
    $(mounted(this.table_ref)).find(".dt-column-order").removeAttr("data-priority");
    if (order.length < 2) {
      return;
    }
    order.forEach(([column], priority) => {
      $(dt.column(column).header())
        .find(".dt-column-order")
        .attr("data-priority", priority + 1);
    });
  }
  updateSelectResultsButton(): void {
    const dt = this.dt;
    if (dt === null) {
      return;
    }
    const node = dt.buttons()[0].node;
    const results = dt.rows({ search: "applied" }).count();
    node.classList.toggle("d-none", !this.isSearching() || results === 0);
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
    this.columnQueries = new Map();
    // Two header rows: titles, which sort and open the column menu, then the column filters.
    const titles = $("<tr>");
    const filters = $("<tr>").addClass("hiplot-filter-row");
    for (const column of this.ordered_cols) {
      if (column === "") {
        titles.append($("<th>").attr("aria-label", "Color"));
        filters.append($("<th>"));
        continue;
      }
      const pd = me.props.params_def[column];
      titles.append(
        $("<th>").append($("<span />").attr("class", pd.label_css).html(pd.label_html)),
      );
      filters.append($("<th>").append(this.filterInput(column)));
    }
    dom.append($("<thead>").append(titles, filters));
    const columns: Array<ConfigColumns> = this.ordered_cols.map((x) => {
      const pd = me.props.params_def[x];
      const column: ConfigColumns = {
        defaultContent: "null",
        type: x === "" ? "html" : pd.numeric ? "num" : "string",
        visible: !me.props.hide?.includes(x),
        orderable: x !== "", // Don't allow to sort by color
      };
      if (x !== "" && pd.numeric) {
        // Shown rounded with the exact value in a tooltip; sorted and searched exactly.
        column.render = (data: DatapointValue, type: string) =>
          type === "display" && typeof data === "number"
            ? `<span title="${data}">${formatTableNumber(data)}</span>`
            : data;
      }
      return column;
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
      orderCellsTop: true,
      deferRender: true, // Create HTML elements only when displayed
      layout: {
        topStart: ["search", "buttons"],
        topEnd: "pageLength",
        bottomStart: "info",
        bottomEnd: "paging",
      },
      language: {
        search: "",
        searchPlaceholder: "Search all columns",
        lengthMenu: "Rows per page _MENU_",
        info: "_START_–_END_ of _TOTAL_ rows",
        infoEmpty: "No rows",
        infoFiltered: "(filtered from _MAX_)",
        zeroRecords: "No row matches the search and filters",
        emptyTable: "No row is selected",
        paginate: PAGING_LABELS,
      },
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
      buttons: {
        dom: {
          container: { className: "dt-buttons" },
          button: { className: controls.button },
        },
        buttons: [
          {
            text: "Select results",
            className: "d-none",
            attr: { title: "Select the rows the search and filters found" },
            action: this.setSelectedToSearchResult.bind(this),
          },
        ],
      },
      colReorder: true,
    });
    dom.wrap('<div class="hiplot-table-scroll"></div>');
    dom.on("search.dt", () => this.updateSelectResultsButton());
    dom.on("order.dt", () => this.markOrderPriorities());

    this.empty = true;
    dom
      .find("tbody")
      .on("mouseenter", "td", function () {
        if (!me.dt || me.empty) {
          return;
        }
        const rowIdx = me.dt.cell(this).index().row;
        const row = me.dt.row(rowIdx);

        dom.find(".hiplot-row-highlight").removeClass("hiplot-row-highlight");
        const rowNode = row.node();
        if (rowNode) {
          $(rowNode).addClass("hiplot-row-highlight");
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
          $(rowNode).removeClass("hiplot-row-highlight");
        }
        me.props.setHighlighted([]);
      });

    me.setSelected(me.props.rows_selected);
    me.markOrderPriorities();
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
      // Selections arrive once per brush gesture (see ParallelPlot), so no debounce.
      this.setSelected(this.props.rows_selected);
    }
  }
  setSelectedToSearchResult() {
    const dt = this.dt;
    if (!dt) {
      return;
    }
    const searchResults: Array<Datapoint> = dt
      .rows({ search: "applied" })
      .data()
      .toArray()
      .map((row: TableRowData) => this.props.dp_lookup[this.getUidFromRowData(row)]);
    const searchTerm = dt.search();
    if (typeof searchTerm !== "string") {
      throw new Error("The table search box only produces string searches");
    }
    const found: Filter[] = [
      ...(searchTerm === "" ? [] : [{ type: FilterType.Search, data: searchTerm } as const]),
      ...this.columnConditions().map(
        ([col]): Filter => ({
          type: FilterType.Column,
          data: { col, query: this.columnQueries.get(col) ?? "" },
        }),
      ),
    ];
    const filters = this.props.rows_selected_filter
      ? [this.props.rows_selected_filter, ...found]
      : found;
    const filter: Filter =
      filters.length === 1 ? filters[0] : { type: FilterType.All, data: filters };
    this.props.setSelected(searchResults, filter);
  }
  setSelected(selected: Array<Datapoint>) {
    const dt = this.dt;
    if (!dt) {
      return;
    }
    const ordered_cols = this.ordered_cols;

    dt.clear();
    dt.rows.add(selected.map((row) => ordered_cols.map((col) => (col === "" ? "" : row[col]))));
    if (this.isSearching()) {
      dt.draw();
    } else {
      // Nothing to search for: skip the filtering pass, which is the slow part of a redraw.
      dt.settings()[0].oFeatures.bFilter = false;
      dt.draw();
      dt.settings()[0].oFeatures.bFilter = true;
    }
    this.empty = selected.length === 0;
    this.updateSelectResultsButton();
  }
  render() {
    return (
      <div className={`${style.wrap} hiplot-table-panel`}>
        <div
          ref={this.table_container}
          className={`sample-table-container ${style.tableContainer}`}
        >
          <table ref={this.table_ref} className="table table-sm sample-rows-table hiplot-table" />
        </div>
      </div>
    );
  }
  destroyDt() {
    this.applyColumnFilters.cancel();
    if (this.dt) {
      const dt = this.dt;
      this.dt = null;
      dt.destroy();
    }
  }
  componentWillUnmount() {
    this.destroyDt();
  }
}
