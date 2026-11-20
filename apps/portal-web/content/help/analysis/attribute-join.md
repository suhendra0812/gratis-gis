---
id: analysis-attribute-join
title: Join by attribute
summary: Attach a count or selected attributes from a second data layer onto each input feature where a key field matches, such as an ID or a code.
category: analysis/select-and-calculate
order: 32
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - attribute-join
  - join
related:
  - items-derived-layer
  - analysis-spatial-join
  - analysis-group-by
---

A **join by attribute** step looks up rows of a second **data
layer** whose key field holds the same value as the input row's
key field. It is the table join of a desktop GIS. The output keeps
the input geometry and adds either a match count or selected
attributes from one matching row.

Matches never multiply rows: each input row comes out once. Use
**count** when you care how many rows matched.

## Inputs

- **Source (pipeline input)**. Its geometry passes through.
- **Other source**. A portal **data layer** you can read. Pick the
  item, and the sublayer key when the item has several sublayers.
- **Key field on this layer** and **Matching field on the other
  layer**. Either can be **Feature ID**, the feature's own global
  ID. That is how a child layer reaches its parent when it stores
  the parent's ID in a field (a relationship foreign key).
- **Ignore upper and lower case** (optional). Keys are compared as
  text with surrounding spaces trimmed, so `12` matches `"12"`. An
  empty key never matches.
- **Fields to keep from this layer**. All input fields carry over
  by default. Untick **Keep all fields** and clear the ones you do
  not want; the key field still works when it is left out.
- **Rows to keep**:
  - **All rows** keeps rows with no match; their joined fields are
    empty, or the count is 0.
  - **Only matched rows** drops rows with no match.
- **Bring over**:
  - **Count of matches** adds `joined_count` (with the default
    prefix).
  - **Attrs from first match** copies the fields you tick, up to
    16, as `joined_<field>`.
- **When several rows match, use the first by** (Attrs from first
  match only). Pick a field of the other layer and a direction, for
  example the activity date, latest first, to bring over each
  channel's most recent activity. Numbers compare by value and dates
  by time; rows with an empty value come last. Without a field, or
  on a tie, the row with the lowest feature ID wins, so the result
  is the same on every read.
- **Field aliases** (optional). The label shown for each output
  field, for both the kept input fields and the joined ones, for
  example `Panjang saluran` for `joined_panjang`. **Use the other
  layer's labels** fills the joined fields from the other layer's
  own labels. Field names stay the same, so expressions and later
  steps keep working.
- **Output prefix**. Defaults to `joined_`. The new names must not
  clash with fields the input already has.

## Output

- Geometry: from the pipeline input (unchanged).
- Attributes: the kept input fields plus `{prefix}count` or the prefixed
  copied fields. Copied fields arrive as text; turn a number back
  into a number with a [Calculate field](analysis-calculate) step
  when a later step needs it.
- Row count: the same as the input with **All rows**, or the number
  of matched rows with **Only matched rows**.

## How to use it

1. New-item wizard, then **Derived layer**.
2. Pick a **Source**.
3. Add **Join by attribute** from **Compare with another layer**.
4. Pick the **other** data layer (and its sublayer key).
5. Pick the key field on each side.
6. Choose which rows to keep and what to bring over.
7. Save.

## Examples

- **Channel name on each cleaning activity**. Source: activity
  points, which store their channel's ID in `saluran_globalid`.
  Other: the channel lines layer. Keys: `saluran_globalid` and
  **Feature ID**. Bring over: `nama_lokasi`, `panjang`.
- **Activities per channel**. Source: the channel lines. Other:
  the activity points. Keys: **Feature ID** and `saluran_globalid`.
  Bring over: **count**. Only matched rows keeps the channels that
  have at least one activity.
- **Latest activity per channel**. As above, but bring over
  `tanggal`, `status` and `persentase` from the first match ordered
  by `tanggal`, highest / latest first.
- **District name by code**. Source: parcels with `district_code`.
  Other: districts with `code`. Tick **Ignore upper and lower
  case** if the codes were typed inconsistently.

## Notes

- **Matching on location instead of a key?** Use
  [Spatial join](analysis-spatial-join).
- **Other source is data_layer only.** A derived layer cannot be
  the other side yet.
