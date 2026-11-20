// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The tool specs next to this file only assert SQL text, which is how
// several tools shipped SQL Postgres refuses to run: untyped
// jsonb_build_object keys (42P18), text compared with numbers in
// filter and calculate-field, triangles that all got the same id in
// contour, and a text[] matched against the uuid entity column. This
// suite runs the generated SQL. node-postgres sends parameters with no
// type, the same as the Prisma pg adapter.

import { join } from 'node:path';
import { Pool } from 'pg';
import type { FeatureField } from '@gratis-gis/shared-types';

import { applyTestMigrations } from '../../testing/apply-test-migrations.js';
import { aggregateGenerator } from './aggregate.js';
import { attributeJoinGenerator } from './attribute-join.js';
import { calculateFieldGenerator } from './calculate-field.js';
import { calculateGeometryGenerator } from './calculate-geometry.js';
import { contourGenerator } from './contour.js';
import { filterGenerator } from './filter.js';
import { spatialFilterGenerator } from './spatial-filter.js';
import { spatialJoinGenerator } from './spatial-join.js';
import { topNGenerator } from './top-n.js';
import type { ToolGenerator } from './types.js';

const TEST_URL = process.env.TEST_DATABASE_URL;
const d = TEST_URL ? describe : describe.skip;

if (process.env.REQUIRE_PG_SPECS === '1' && !TEST_URL) {
  throw new Error('REQUIRE_PG_SPECS=1 but TEST_DATABASE_URL is unset; the tool SQL suite would silently skip.');
}

jest.setTimeout(180_000);

const SCHEMA: FeatureField[] = [
  { name: 'acres', label: 'Acres', type: 'number', nullable: true },
  { name: 'zone', label: 'Zone', type: 'string', nullable: true },
];

// A 5 x 5 grid of points. acres = x + y, with one junk value, and
// polygons for the area measure.
const SOURCE = `src AS (
  SELECT gen_random_uuid() AS global_id,
         ST_SetSRID(ST_MakePoint(x * 0.01, y * 0.01), 4326) AS geom,
         jsonb_build_object(
           'acres', CASE WHEN x = 4 AND y = 4 THEN 'n/a' ELSE (x + y)::text END,
           'zone', CASE WHEN x < 2 THEN 'A' ELSE 'B' END
         ) AS properties
  FROM generate_series(0, 4) x, generate_series(0, 4) y
  UNION ALL
  SELECT gen_random_uuid(), ST_MakeEnvelope(0, 0, 0.01, 0.01, 4326),
         jsonb_build_object('acres', '1e3', 'zone', 'C')
)`;

d('derived-layer tool SQL runs against Postgres', () => {
  let pool: Pool;
  const dbName = 'gg_b5_tool_sql';

  beforeAll(async () => {
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(TEST_URL!);
    url.pathname = `/${dbName}`;
    applyTestMigrations(url.toString(), join(__dirname, '../../../prisma/migrations'));
    pool = new Pool({ connectionString: url.toString(), max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: TEST_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  });

  async function run<T>(
    gen: ToolGenerator<T>,
    raw: unknown,
    select = 'SELECT properties FROM q',
  ) {
    const params = gen.validate(raw, { sourceSchema: SCHEMA });
    const frag = gen.toSql('src', params, 0, { inputSchema: SCHEMA });
    return pool.query(`WITH ${SOURCE}, q AS (${frag.sql}) ${select}`, frag.params);
  }

  it('filter compares a number field as a number and skips junk values', async () => {
    const r = await run(filterGenerator, { expression: '{{acres}} > 6' }, 'SELECT count(*)::int AS n FROM q');
    // x + y > 6 on the grid: (3,4) (4,3) and the 1e3 row; (4,4) is "n/a".
    expect(r.rows[0].n).toBe(3);
  });

  it('calculate-field does arithmetic on a number field', async () => {
    const r = await run(
      calculateFieldGenerator,
      { outputName: 'ha', outputType: 'number', expression: 'round({{acres}} * 0.4047)' },
      "SELECT max((properties->>'ha')::float) AS m FROM q",
    );
    expect(Number(r.rows[0].m)).toBe(405);
  });

  it('calculate-geometry plans with a parameter as the JSON key', async () => {
    const r = await run(
      calculateGeometryGenerator,
      { measurement: 'area', unit: 'square-meters', fieldName: 'area_m2' },
      "SELECT count(*)::int AS n FROM q WHERE properties ? 'area_m2'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it('aggregate sums a number field with a junk value in it', async () => {
    const r = await run(
      aggregateGenerator,
      { groupBy: ['zone'], aggs: [{ op: 'sum', field: 'acres', outputName: 'total' }] },
      "SELECT properties->>'zone' AS zone, (properties->>'total')::float AS total FROM q ORDER BY 1",
    );
    const byZone = Object.fromEntries(r.rows.map((x) => [x.zone, x.total]));
    expect(byZone.C).toBe(1000);
    expect(byZone.A).toBe(25);
  });

  it('top-n counts scientific notation as a number', async () => {
    const r = await run(
      topNGenerator,
      { field: 'acres', n: 1, direction: 'desc' },
      "SELECT properties->>'acres' AS v FROM q",
    );
    expect(r.rows[0].v).toBe('1e3');
  });

  it('contour builds one row per triangle and returns lines', async () => {
    const params = contourGenerator.validate(
      { field: 'acres', mode: 'manual', levels: [2.5, 4.5] },
      { sourceSchema: SCHEMA },
    );
    const enriched = await contourGenerator.enrich!(params, {
      sourceSchema: SCHEMA,
      sourceTable: 'unused',
      queryRaw: async () => [],
    });
    const frag = contourGenerator.toSql('pts_src', enriched, 0);
    const r = await pool.query(
      `WITH ${SOURCE}, pts_src AS (SELECT * FROM src WHERE GeometryType(geom) = 'POINT'), q AS (${frag.sql})
       SELECT count(*)::int AS n, count(DISTINCT properties->>'level')::int AS levels FROM q`,
      frag.params,
    );
    expect(r.rows[0].n).toBeGreaterThan(4);
    expect(r.rows[0].levels).toBe(2);
  });

  it('attribute-join matches by a field or by the feature id', async () => {
    const itemId = '00000000-0000-4000-8000-0000000000f1';
    const scope = `data_layer:${itemId}:zones`;
    // Zone A has two rows, zone B one, zone C none. The other layer's
    // feature ids are fixed so the source can point at one of them.
    // rank 10 sorts before 9 as text, after it as a number.
    const rows: Array<[string, string, string, string]> = [
      ['00000000-0000-4000-8000-00000000a001', ' a ', 'Alpha 1', '10'],
      ['00000000-0000-4000-8000-00000000a002', 'A', 'Alpha 2', '9'],
      ['00000000-0000-4000-8000-00000000b001', 'B', 'Bravo', ''],
    ];
    for (const [entity, code, name, rank] of rows) {
      await pool.query(
        `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents, geom, attrs)
         VALUES (gen_random_uuid(), now(), now(), $1, $2, 'create', 'test', '{}'::jsonb, '{}'::uuid[],
                 ST_SetSRID(ST_MakePoint(0, 0), 4326), jsonb_build_object('code', $3::text, 'name', $4::text, 'rank', $5::text))`,
        [scope, entity, code, name, rank],
      );
    }
    const otherSource = { kind: 'data_layer', itemId, layerKey: 'zones' };

    const count = await run(
      attributeJoinGenerator,
      { otherSource, leftField: 'zone', rightField: 'code', attributeStrategy: 'count', ignoreCase: true },
      "SELECT properties->>'zone' AS zone, min((properties->>'joined_count')::int) AS n, count(*)::int AS rows FROM q GROUP BY 1 ORDER BY 1",
    );
    expect(count.rows).toEqual([
      { zone: 'A', n: 2, rows: 10 },
      { zone: 'B', n: 1, rows: 15 },
      { zone: 'C', n: 0, rows: 1 },
    ]);

    // Case-sensitive: " a " no longer matches, so A finds only Alpha 2.
    const first = await run(
      attributeJoinGenerator,
      { otherSource, leftField: 'zone', rightField: 'code', attributeStrategy: 'first', attrsToKeep: ['name'], joinType: 'inner' },
      "SELECT DISTINCT properties->>'zone' AS zone, properties->>'joined_name' AS name FROM q ORDER BY 1",
    );
    expect(first.rows).toEqual([
      { zone: 'A', name: 'Alpha 2' },
      { zone: 'B', name: 'Bravo' },
    ]);

    // orderBy picks which match wins: rank as a number, both ways.
    for (const [direction, expected] of [['asc', 'Alpha 2'], ['desc', 'Alpha 1']] as const) {
      const ordered = await run(
        attributeJoinGenerator,
        {
          otherSource, leftField: 'zone', rightField: 'code', ignoreCase: true,
          attributeStrategy: 'first', attrsToKeep: ['name'], orderBy: { field: 'rank', direction },
        },
        "SELECT DISTINCT properties->>'joined_name' AS name FROM q WHERE properties->>'zone' = 'A'",
      );
      expect(ordered.rows).toEqual([{ name: expected }]);
    }

    // keepFields cuts the input fields down; the key need not be kept.
    const kept = await run(
      attributeJoinGenerator,
      {
        otherSource, leftField: 'zone', rightField: 'code', joinType: 'inner',
        attributeStrategy: 'first', attrsToKeep: ['name'], keepFields: ['acres'],
      },
      "SELECT DISTINCT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(properties) k) AS keys FROM q",
    );
    expect(kept.rows).toEqual([{ keys: ['acres', 'joined_name'] }]);

    // Feature id on the right: a foreign key holding the parent's id.
    const params = attributeJoinGenerator.validate({
      otherSource,
      leftField: 'parent',
      rightField: '$id',
      attributeStrategy: 'first',
      attrsToKeep: ['name'],
    });
    const frag = attributeJoinGenerator.toSql('kids', params, 0);
    const byId = await pool.query(
      `WITH kids AS (
         SELECT gen_random_uuid() AS global_id, NULL::geometry AS geom,
                jsonb_build_object('parent', p) AS properties
         FROM unnest(ARRAY['00000000-0000-4000-8000-00000000b001', 'missing']) p
       ), q AS (${frag.sql})
       SELECT properties->>'parent' AS parent, properties->'joined_name' AS name FROM q ORDER BY 1`,
      frag.params,
    );
    expect(byId.rows).toEqual([
      { parent: '00000000-0000-4000-8000-00000000b001', name: 'Bravo' },
      { parent: 'missing', name: null },
    ]);
  });

  it('spatial-join keeps only the chosen input fields', async () => {
    const itemId = '00000000-0000-4000-8000-0000000000d1';
    await pool.query(
      `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents, geom, attrs)
       VALUES (gen_random_uuid(), now(), now(), $1, gen_random_uuid(), 'create', 'test', '{}'::jsonb, '{}'::uuid[],
               ST_MakeEnvelope(-0.001, -0.001, 0.015, 0.015, 4326), '{"name": "Box"}'::jsonb)`,
      [`data_layer:${itemId}:default`],
    );
    const otherSource = { kind: 'data_layer', itemId };
    // The box holds the four points with x, y in {0, 1} and touches
    // the source polygon. Aliases do not change the stored keys.
    const r = await run(
      spatialJoinGenerator,
      {
        otherSource, predicate: 'intersects', attributeStrategy: 'first',
        attrsToKeep: ['name'], keepFields: ['zone'], aliases: { zone: 'Zona', joined_name: 'Nama' },
      },
      `SELECT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(properties) k) AS keys, count(*)::int AS n
       FROM q GROUP BY 1 ORDER BY 2`,
    );
    expect(r.rows).toEqual([
      { keys: ['joined_name', 'zone'], n: 5 },
      { keys: ['zone'], n: 21 },
    ]);
  });

  it('spatial-filter restricts the other layer to a selection of uuids', async () => {
    const itemId = '00000000-0000-4000-8000-0000000000e1';
    const entity = '00000000-0000-4000-8000-0000000000e2';
    await pool.query(
      `INSERT INTO observation (id, tx_time, valid_from, scope, entity, kind, author_sub, source, parents, geom, attrs)
       VALUES (gen_random_uuid(), now(), now(), $1, $2, 'create', 'test', '{}'::jsonb, '{}'::uuid[],
               ST_MakeEnvelope(-1, -1, 1, 1, 4326), '{}'::jsonb)`,
      [`data_layer:${itemId}:default`, entity],
    );
    const params = spatialFilterGenerator.validate(
      {
        otherSource: { kind: 'data_layer', itemId, featureIds: [entity] },
        predicate: 'intersects',
      },
      { sourceSchema: SCHEMA },
    );
    const frag = spatialFilterGenerator.toSql('src', params, 0);
    const r = await pool.query(
      `WITH ${SOURCE}, q AS (${frag.sql}) SELECT count(*)::int AS n FROM q`,
      frag.params,
    );
    expect(r.rows[0].n).toBe(26);
  });
});
