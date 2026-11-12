use std::cell::RefCell;
use std::cmp::Ordering;

const EMPTY: u32 = u32::MAX;
/// Field order is the Float64 ABI consumed by src/wasm/kernels.ts.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Pixel {
    selected: f64,
    context: f64,
    selected_peak: f64,
    context_peak: f64,
    color0: f64,
    color1: f64,
    color2: f64,
    winner: f64,
    winner_coverage: f64,
}

impl Default for Pixel {
    fn default() -> Self {
        Self {
            selected: 0.0,
            context: 0.0,
            selected_peak: 0.0,
            context_peak: 0.0,
            color0: 0.0,
            color1: 0.0,
            color2: 0.0,
            winner: EMPTY as f64,
            winner_coverage: 0.0,
        }
    }
}

#[derive(Default)]
struct Workspace {
    endpoints: [Vec<f32>; 2],
    endpoint_slot: usize,
    selection: Vec<u8>,
    ranks: Vec<u32>,
    palette: Vec<u32>,
    palette_source: Vec<f64>,
    statistics: Vec<Pixel>,
    values: Vec<f64>,
    order: Vec<u32>,
    missing: Vec<u32>,
    sorted: Vec<f64>,
    codes: Vec<i32>,
    category_text: Vec<u16>,
    category_starts: Vec<u32>,
    category_values: Vec<u32>,
    category_offsets: Vec<u32>,
    histogram_counts: Vec<u32>,
    histogram_colors: Vec<f64>,
    histogram_stride: usize,
    histogram_extra: bool,
    histogram_compact: bool,
    histogram_reset: bool,
    histogram_slot: usize,
    histogram_dirty: Vec<u8>,
    packed: Vec<Option<PackedHistogram>>,
}

#[derive(Default)]
struct PackedHistogram {
    cells: Vec<u32>,
    rows: Vec<usize>,
    counts: Vec<f32>,
    extra: Vec<f32>,
    dirty_rows: Vec<u32>,
}

thread_local! {
    static WORKSPACE: RefCell<Workspace> = RefCell::new(Workspace::default());
}

// The bridge copies inputs after prepare and reads results before the next call.
// No exported operation retains a JS reference or dereferences a foreign pointer.
#[unsafe(no_mangle)]
pub extern "C" fn prepare(rows: usize, height: usize, palette: usize, slot: usize) {
    WORKSPACE.with_borrow_mut(|w| {
        w.endpoint_slot = slot;
        w.endpoints[slot].resize(rows, 0.0);
        w.selection.resize(rows, 0);
        w.ranks.resize(rows, 0);
        w.palette.resize(palette, 0);
        w.palette_source.resize(palette, 0.0);
        w.statistics.resize(height, Pixel::default());
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_numeric(rows: usize) {
    WORKSPACE.with_borrow_mut(|w| {
        w.values.resize(rows, 0.0);
        w.selection.resize(rows, 0);
        w.order.clear();
        w.missing.clear();
        w.sorted.clear();
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn buffer(kind: u32) -> *const u8 {
    WORKSPACE.with_borrow(|w| match kind {
        0 => w.endpoints[w.endpoint_slot].as_ptr().cast(),
        1 => w.selection.as_ptr(),
        2 => w.ranks.as_ptr().cast(),
        3 => w.palette.as_ptr().cast(),
        4 => w.statistics.as_ptr().cast(),
        5 => w.values.as_ptr().cast(),
        6 => w.order.as_ptr().cast(),
        7 => w.missing.as_ptr().cast(),
        8 => w.sorted.as_ptr().cast(),
        9 => w.palette_source.as_ptr().cast(),
        10 => w.codes.as_ptr().cast(),
        11 => w.category_text.as_ptr().cast(),
        12 => w.category_starts.as_ptr().cast(),
        13 => w.category_values.as_ptr().cast(),
        14 => w.category_offsets.as_ptr().cast(),
        15 => w.histogram_counts.as_ptr().cast(),
        16 => w.histogram_colors.as_ptr().cast(),
        17 => w.packed[w.histogram_slot]
            .as_ref()
            .unwrap()
            .cells
            .as_ptr()
            .cast(),
        18 => w.packed[w.histogram_slot]
            .as_ref()
            .unwrap()
            .counts
            .as_ptr()
            .cast(),
        19 => w.packed[w.histogram_slot]
            .as_ref()
            .unwrap()
            .extra
            .as_ptr()
            .cast(),
        20 => w.packed[w.histogram_slot]
            .as_ref()
            .unwrap()
            .dirty_rows
            .as_ptr()
            .cast(),
        _ => panic!("Unknown kernel buffer"),
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn create_histogram() -> usize {
    WORKSPACE.with_borrow_mut(|w| {
        if let Some(slot) = w.packed.iter().position(Option::is_none) {
            w.packed[slot] = Some(PackedHistogram::default());
            return slot;
        }
        w.packed.push(Some(PackedHistogram::default()));
        w.packed.len() - 1
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn release_histogram(slot: usize) {
    WORKSPACE.with_borrow_mut(|w| {
        w.packed[slot] = None;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_histogram(
    slot: usize,
    stride: usize,
    occupied: usize,
    extra: u32,
    reset: u32,
    compact: u32,
) -> u32 {
    WORKSPACE.with_borrow_mut(|w| {
        let cells = stride * stride;
        w.histogram_slot = slot;
        w.histogram_stride = stride;
        w.histogram_extra = extra != 0;
        w.histogram_compact = compact != 0;
        let source_cells = if compact != 0 { occupied } else { cells };
        w.histogram_counts
            .resize(source_cells * if extra != 0 { 4 } else { 2 }, 0);
        w.histogram_colors
            .resize(source_cells * if extra != 0 { 3 } else { 2 }, 0.0);
        w.histogram_dirty.resize(stride, 0);
        let packed = w.packed[slot].as_mut().unwrap();
        let resized = packed.counts.len() != cells * 4;
        w.histogram_reset = reset != 0 || resized || packed.cells.len() != occupied;
        packed.cells.resize(occupied, 0);
        packed.counts.resize(cells * 4, 0.0);
        let extra_length = if extra != 0 { cells * 4 } else { 4 };
        let extra_resized = packed.extra.len() != extra_length;
        packed.extra.resize(extra_length, 0.0);
        if reset != 0 || resized {
            packed.counts.fill(0.0);
        }
        if reset != 0 || resized || extra_resized {
            packed.extra.fill(0.0);
        }
        u32::from(w.histogram_reset)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn pack_histogram() -> usize {
    WORKSPACE.with_borrow_mut(|w| {
        let stride = w.histogram_stride;
        let cells = stride * stride;
        let packed = w.packed[w.histogram_slot].as_mut().unwrap();
        let source_cells = if w.histogram_compact {
            packed.cells.len()
        } else {
            cells
        };
        if w.histogram_reset {
            packed.rows.clear();
            packed
                .rows
                .extend(packed.cells.iter().map(|&cell| cell as usize / stride));
        }
        w.histogram_dirty.fill(0);
        for (index, &cell) in packed.cells.iter().enumerate() {
            let cell = cell as usize;
            let source = if w.histogram_compact { index } else { cell };
            let offset = cell * 4;
            let counts = [
                w.histogram_counts[source] as f32,
                w.histogram_counts[source_cells + source] as f32,
                w.histogram_colors[source] as f32,
                w.histogram_colors[source_cells + source] as f32,
            ];
            let mut changed = false;
            for (channel, value) in counts.into_iter().enumerate() {
                changed |= packed.counts[offset + channel].to_bits() != value.to_bits();
                packed.counts[offset + channel] = value;
            }
            if w.histogram_extra {
                let minimum = w.histogram_counts[source_cells * 2 + source];
                let maximum = w.histogram_counts[source_cells * 3 + source];
                let extra = [
                    w.histogram_colors[source_cells * 2 + source] as f32,
                    if minimum == EMPTY {
                        -1.0
                    } else {
                        minimum as f32
                    },
                    if maximum == EMPTY {
                        -1.0
                    } else {
                        maximum as f32
                    },
                    0.0,
                ];
                for (channel, value) in extra.into_iter().enumerate() {
                    changed |= packed.extra[offset + channel].to_bits() != value.to_bits();
                    packed.extra[offset + channel] = value;
                }
            }
            if changed {
                w.histogram_dirty[packed.rows[index]] = 1;
            }
        }
        packed.dirty_rows.clear();
        packed.dirty_rows.extend(
            w.histogram_dirty
                .iter()
                .enumerate()
                .filter_map(|(row, &changed)| (changed != 0).then_some(row as u32)),
        );
        packed.dirty_rows.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn quantize_palette() {
    WORKSPACE.with_borrow_mut(|w| {
        for (fixed, channel) in w.palette.iter_mut().zip(&w.palette_source) {
            *fixed = (channel / 255.0 * 65535.0).round() as u32;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_categorical(rows: usize, categories: usize, units: usize) {
    WORKSPACE.with_borrow_mut(|w| {
        w.codes.resize(rows, -1);
        w.category_text.resize(units, 0);
        w.category_starts.resize(categories + 1, 0);
        w.order.clear();
        w.missing.clear();
        w.category_values.clear();
        w.category_offsets.clear();
    });
}

fn category(w: &Workspace, code: usize) -> &[u16] {
    &w.category_text[w.category_starts[code] as usize..w.category_starts[code + 1] as usize]
}

#[unsafe(no_mangle)]
pub extern "C" fn group_categorical() -> usize {
    WORKSPACE.with_borrow_mut(|w| {
        let categories = w.category_starts.len() - 1;
        // UTF-16 units preserve JS lexical order, including unpaired surrogates.
        let mut lexical: Vec<usize> = (0..categories).collect();
        lexical.sort_unstable_by(|&a, &b| category(w, a).cmp(category(w, b)).then(a.cmp(&b)));
        let mut group_of = vec![0; categories];
        let mut representatives = Vec::new();
        for code in lexical {
            if representatives
                .last()
                .is_none_or(|&previous| category(w, code) != category(w, previous))
            {
                representatives.push(code);
            }
            group_of[code] = representatives.len() - 1;
        }
        let mut counts = vec![0; representatives.len()];
        for (row, &code) in w.codes.iter().enumerate() {
            if code == -1 {
                w.missing.push(row as u32);
            } else {
                assert!(
                    code >= 0 && (code as usize) < categories,
                    "Invalid categorical code"
                );
                counts[group_of[code as usize]] += 1;
            }
        }
        let mut starts = vec![0; counts.len()];
        let mut present = 0;
        for (group, &count) in counts.iter().enumerate() {
            starts[group] = present;
            if count > 0 {
                w.category_values.push(representatives[group] as u32);
                w.category_offsets.push(present as u32);
            }
            present += count;
        }
        w.category_offsets.push(present as u32);
        w.order.resize(present, 0);
        // Ascending row traversal makes buckets stable, including duplicate category definitions.
        for (row, &code) in w.codes.iter().enumerate() {
            if code != -1 {
                let position = &mut starts[group_of[code as usize]];
                w.order[*position] = row as u32;
                *position += 1;
            }
        }
        w.category_values.len()
    })
}

fn compare_numeric(values: &[f64], a: u32, b: u32) -> Ordering {
    let x = values[a as usize];
    let y = values[b as usize];
    match (x.is_nan(), y.is_nan()) {
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (true, true) => a.cmp(&b),
        (false, false) => x.partial_cmp(&y).unwrap().then(a.cmp(&b)),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn sort_numeric() -> usize {
    WORKSPACE.with_borrow_mut(|w| {
        for row in 0..w.values.len() {
            if w.selection[row] == 0 {
                w.order.push(row as u32);
            } else {
                w.missing.push(row as u32);
            }
        }
        w.order
            .sort_unstable_by(|&a, &b| compare_numeric(&w.values, a, b));
        w.sorted
            .extend(w.order.iter().map(|&row| w.values[row as usize]));
        w.sorted.partition_point(|value| !value.is_nan())
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn present_count() -> usize {
    WORKSPACE.with_borrow(|w| w.order.len())
}

#[unsafe(no_mangle)]
pub extern "C" fn reduce_marginal(
    height: usize,
    line_width: f64,
    color_bins: u32,
    mode: u32,
    pixel_ratio: f64,
) {
    WORKSPACE.with_borrow_mut(|w| {
        let line_width = line_width * pixel_ratio;
        w.statistics.fill(Pixel::default());
        let half_width = (line_width / 2.0).max(0.5);
        let line_scale = line_width.min(1.0);
        for row in 0..w.endpoints[w.endpoint_slot].len() {
            let endpoint = w.endpoints[w.endpoint_slot][row] as f64 * pixel_ratio;
            if !endpoint.is_finite() {
                continue;
            }
            let first = (endpoint - half_width - 1.0).ceil().max(0.0);
            let last = (endpoint + half_width).floor().min(height as f64 - 1.0);
            if first > last {
                continue;
            }
            let rank = w.ranks[row];
            for y in first as usize..=last as usize {
                let coverage = (half_width + 0.5 - (y as f64 + 0.5 - endpoint).abs())
                    .clamp(0.0, 1.0)
                    * line_scale;
                if coverage <= 0.0 {
                    continue;
                }
                let pixel = &mut w.statistics[y];
                if w.selection[row] == 0 {
                    pixel.context += coverage;
                    pixel.context_peak = pixel.context_peak.max(coverage);
                    continue;
                }
                pixel.selected += coverage;
                pixel.selected_peak = pixel.selected_peak.max(coverage);
                if color_bins == 0 {
                    let offset = rank as usize * 3;
                    pixel.color0 += w.palette[offset] as f64 * coverage;
                    pixel.color1 += w.palette[offset + 1] as f64 * coverage;
                    pixel.color2 += w.palette[offset + 2] as f64 * coverage;
                } else if rank == color_bins {
                    pixel.color1 += coverage;
                } else {
                    pixel.color0 += rank as f64 * coverage;
                    if mode == 0 {
                        continue;
                    }
                    let winner = pixel.winner as u32;
                    if winner == EMPTY
                        || (mode == 1 && rank < winner)
                        || (mode == 2 && rank > winner)
                    {
                        pixel.winner = rank as f64;
                        pixel.winner_coverage = coverage;
                    } else if rank == winner {
                        pixel.winner_coverage = pixel.winner_coverage.max(coverage);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_slots_retain_unsorted_cells_across_interleaved_updates() {
        let first = create_histogram();
        let second = create_histogram();
        assert_eq!(prepare_histogram(first, 3, 3, 1, 1, 1), 1);
        WORKSPACE.with_borrow_mut(|w| {
            w.packed[first]
                .as_mut()
                .unwrap()
                .cells
                .copy_from_slice(&[8, 1, 6]);
            w.histogram_counts
                .copy_from_slice(&[1, 2, 3, 4, 5, 6, EMPTY, 2, 3, 4, 5, 6]);
            w.histogram_colors.copy_from_slice(&[10.0; 9]);
        });
        assert_eq!(pack_histogram(), 2);
        WORKSPACE.with_borrow(|w| {
            let packed = w.packed[first].as_ref().unwrap();
            assert_eq!(packed.dirty_rows, [0, 2]);
            assert_eq!(packed.counts[8 * 4], 1.0);
            assert_eq!(packed.extra[8 * 4 + 1], -1.0);
        });
        assert_eq!(prepare_histogram(second, 2, 1, 0, 1, 1), 1);
        WORKSPACE.with_borrow_mut(|w| {
            w.packed[second].as_mut().unwrap().cells[0] = 2;
        });
        pack_histogram();
        assert_eq!(prepare_histogram(first, 3, 3, 1, 0, 1), 0);
        WORKSPACE.with_borrow_mut(|w| {
            w.histogram_counts
                .copy_from_slice(&[2, 2, 3, 4, 5, 6, EMPTY, 2, 3, 4, 5, 6]);
            w.histogram_colors.copy_from_slice(&[10.0; 9]);
        });
        assert_eq!(pack_histogram(), 1);
        WORKSPACE.with_borrow(|w| {
            let packed = w.packed[first].as_ref().unwrap();
            assert_eq!(packed.dirty_rows, [2]);
            assert_eq!(packed.counts[8 * 4], 2.0);
        });
        release_histogram(first);
        release_histogram(second);
    }

    #[test]
    fn categorical_buckets_merge_equal_names_and_skip_unused_groups() {
        prepare_categorical(6, 4, 4);
        WORKSPACE.with_borrow_mut(|w| {
            w.codes.copy_from_slice(&[0, 1, -1, 2, 1, 0]);
            w.category_text.copy_from_slice(&[122, 97, 122, 98]);
            w.category_starts.copy_from_slice(&[0, 1, 2, 3, 4]);
        });
        assert_eq!(group_categorical(), 2);
        WORKSPACE.with_borrow(|w| {
            assert_eq!(w.order, [1, 4, 0, 3, 5]);
            assert_eq!(w.missing, [2]);
            assert_eq!(w.category_values, [1, 0]);
            assert_eq!(w.category_offsets, [0, 2, 5]);
        });
    }

    #[test]
    fn pixel_abi_has_nine_contiguous_float64_fields() {
        assert_eq!(std::mem::size_of::<Pixel>(), 9 * 8);
        assert_eq!(std::mem::offset_of!(Pixel, selected), 0);
        assert_eq!(std::mem::offset_of!(Pixel, context), 8);
        assert_eq!(std::mem::offset_of!(Pixel, selected_peak), 16);
        assert_eq!(std::mem::offset_of!(Pixel, context_peak), 24);
        assert_eq!(std::mem::offset_of!(Pixel, color0), 32);
        assert_eq!(std::mem::offset_of!(Pixel, color1), 40);
        assert_eq!(std::mem::offset_of!(Pixel, color2), 48);
        assert_eq!(std::mem::offset_of!(Pixel, winner), 56);
        assert_eq!(std::mem::offset_of!(Pixel, winner_coverage), 64);
    }

    #[test]
    fn numeric_order_keeps_ties_nan_and_missing_identity() {
        prepare_numeric(8);
        WORKSPACE.with_borrow_mut(|w| {
            w.values.copy_from_slice(&[
                1.0,
                f64::NAN,
                -0.0,
                0.0,
                f64::NEG_INFINITY,
                f64::INFINITY,
                1.0,
                2.0,
            ]);
            w.selection[7] = 1;
        });
        assert_eq!(sort_numeric(), 6);
        WORKSPACE.with_borrow(|w| {
            assert_eq!(w.order, [4, 2, 3, 0, 6, 5, 1]);
            assert_eq!(w.missing, [7]);
        });
    }

    #[test]
    fn marginal_keeps_subpixel_coverage_and_extreme_multiplicity() {
        prepare(4, 3, 0, 0);
        WORKSPACE.with_borrow_mut(|w| {
            w.endpoints[0].copy_from_slice(&[0.25, 0.5, 0.75, f32::NAN]);
            w.selection.copy_from_slice(&[1, 0, 1, 1]);
            w.ranks.copy_from_slice(&[2, 0, 2, 3]);
        });
        reduce_marginal(3, 1.0, 3, 1, 1.0);
        WORKSPACE.with_borrow(|w| {
            assert_eq!(
                w.statistics[0],
                Pixel {
                    selected: 1.5,
                    context: 1.0,
                    selected_peak: 0.75,
                    context_peak: 1.0,
                    color0: 3.0,
                    winner: 2.0,
                    winner_coverage: 0.75,
                    ..Pixel::default()
                }
            );
            assert_eq!(w.statistics[1].selected, 0.25);
        });
    }
}
