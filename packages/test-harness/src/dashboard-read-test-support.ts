import assert from "node:assert/strict";
import type { PostgresRuntimePool, RlsSessionContext } from "@software-factory/database";

export async function contents(pool: PostgresRuntimePool,fx:{a:string;b:string;scope:RlsSessionContext}) {
  const result:unknown[]=[];
  // Observer covers every project-scoped business table, including empty tables.
  const tables=await pool.queryInActiveTx("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='project_id' ORDER BY table_name;");
  const sensitive=tables.rows.map((r)=>String(r.table_name));
  assert.ok(sensitive.includes("budget_denial_intents") && sensitive.includes("task_leases"));
  for(const project of [fx.a,fx.b]) await pool.withRlsTransaction({...fx.scope,currentProjectId:project},async()=>{
    for(const table of sensitive) {
      assert.match(table,/^[a-z][a-z0-9_]*$/);
      result.push([project,table,(await pool.queryInActiveTx(`SELECT to_jsonb(t)::text AS content FROM ${table} t WHERE project_id=$1::uuid ORDER BY to_jsonb(t)::text;`,[project])).rows]);
    }
  });
  return JSON.stringify(result);
}
export async function catalog(pool:PostgresRuntimePool) {
  const definitions=[
    "SELECT c.relname,c.relkind,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname;",
    "SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attacl::text,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum;",
    "SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname;",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname;",
    "SELECT tablename,policyname,roles::text,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;",
    "SELECT c.conname,c.conrelid::regclass::text,pg_get_constraintdef(c.oid,true) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY c.conrelid::regclass::text,c.conname;",
  ];
  const result:unknown[]=[];
  for(const sql of definitions)result.push((await pool.queryInActiveTx(sql)).rows);
  return JSON.stringify(result);
}
