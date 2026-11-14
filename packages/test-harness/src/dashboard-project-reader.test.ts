import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { CoreApiService, CoreApiHttpServer, CORE_API_AUTH_HEADER, encodeCoreApiAuthHeader, ProjectReadCursorCodec, ReadProjectionError, type CoreApiAuthContext } from "@software-factory/core-api";
import { SoftwareFactoryControlPlaneStore, PostgresControlPlaneRepository, PostgresRuntimePool, buildPostgresPoolConfigFromEnv, readTimestamp, type ControlPlaneStore, type ProjectMemberRole, type ProjectReadDto } from "@software-factory/database";

// All secrets are ephemeral fixtures. No provider, Git, worker or recovery is needed.
const roles: ProjectMemberRole[] = ["AUDITOR", "DEVELOPER", "PROJECT_APPROVER", "ORG_ADMIN"];
async function fixture(store: ControlPlaneStore) {
  const a = randomUUID(), b = randomUUID();
  for (const id of [a, b]) await store.withRlsTransaction({currentProjectId:id, currentRole:"system_admin_role"}, async () => {
    await store.createProject({project_id:id, slug:`reader-${id}`, name:`Actual project ${id}`, repo_bare_path:"/private/never-expose.git", initial_main_commit_hash:"a".repeat(40)});
    for (const role of roles) await store.addProjectMembership({project_id:id, principal_id:role, member_role:role});
  });
  const core = new CoreApiService(store);
  const auth = (role: ProjectMemberRole = "AUDITOR", projectId = a, principalId: string = role) => core.issueAuthContext({projectId,principalId,roles:[role]});
  const codec = new ProjectReadCursorCodec((data) => core.authenticator.signProjectReadCursor(data));
  const scope = {currentProjectId:a,currentPrincipalId:"AUDITOR",currentRole:"core_api_service" as const};
  return {store,core,a,b,auth,codec,scope};
}
type Fx = Awaited<ReturnType<typeof fixture>>;
async function start(fx: Fx) {
  const server = new CoreApiHttpServer({coreApi:fx.core});
  const endpoint = await server.start();
  const get = async(path = "", auth: CoreApiAuthContext | null = fx.auth(), rawHeader?:string) => {
    const response = await fetch(`${endpoint.baseUrl}/api/v1/projects${path}`,{headers:rawHeader ? {[CORE_API_AUTH_HEADER]:rawHeader} : auth ? {[CORE_API_AUTH_HEADER]:encodeCoreApiAuthHeader(auth)} : {}});
    return {status:response.status, body:await response.json() as Record<string, any>};
  };
  return {get,stop:() => server.stop()};
}
async function expectError(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise,(e:unknown) => e instanceof ReadProjectionError && e.httpStatus === status);
}
function memorySnapshot(store: SoftwareFactoryControlPlaneStore) {
  return JSON.stringify(Object.entries(store).filter(([,v]) => v instanceof Map).map(([k,v]) => [k,v]),(_key,value:unknown) => value instanceof Map ? [...value.entries()] : value);
}
async function contract(fx: Fx) {
  const http = await start(fx);
  const read=fx.store.readProjectProjection.bind(fx.store);let readCalls=0;
  fx.store.readProjectProjection=async(input)=>{readCalls++;return read(input);};
  try {
    for (const role of roles) {
      const detail = await http.get(`/${fx.a}`,fx.auth(role));
      assert.equal(detail.status,200);
      assert.deepEqual(Object.keys(detail.body).sort(),["fetchedAt","project","schemaVersion"]);
      assert.equal(detail.body.schemaVersion,"dashboard-read-v1");
      assert.equal(detail.body.project.name,`Actual project ${fx.a}`);
      assert.deepEqual(Object.keys(detail.body.project).sort(),["createdAt","defaultBranch","name","projectId","slug","updatedAt"]);
      assert.match(detail.body.project.updatedAt,/\.\d{6}Z$/);
      assert.match(detail.body.fetchedAt,/\.\d{6}Z$/);
      assert.equal(JSON.stringify(detail.body).includes("private"),false);
      const list = await http.get("",fx.auth(role));
      assert.equal(list.status,200);
      assert.deepEqual(list.body.scope,{kind:"project-token",projectId:fx.a});
      assert.deepEqual(list.body.items,[detail.body.project]);
      assert.deepEqual(list.body.page,{limit:20,hasMore:false,nextCursor:null});
      assert.deepEqual((await http.get(`/${fx.b}`,fx.auth(role))).body,(await http.get(`/${randomUUID()}`,fx.auth(role))).body);
      assert.equal((await http.get(`/${fx.b}`,fx.auth(role))).status,403);
    }
    assert.equal((await http.get("",null)).status,401);
    assert.equal((await http.get("",{} as CoreApiAuthContext)).status,403);
    assert.equal((await http.get("",null,"invalid-auth-header")).status,401);
    assert.equal((await http.get("",{...fx.auth(),principalId:"changed"})).status,403);
    assert.equal((await http.get("",fx.auth("AUDITOR",fx.a,"non-member"))).status,403);
    assert.equal((await http.get("",fx.core.issueAuthContext({projectId:fx.a,principalId:"AUDITOR",roles:["DEVELOPER"]}))).status,403);
    for (const query of ["limit=0","limit=-1","limit=101","limit=1.5","limit=","limit=01","limit=1&limit=2","stage=Ready","anything=x","cursor=","cursor=x","cursor="+"a".repeat(2049)]) {
      const calls=readCalls;
      assert.equal((await http.get(`?${query}`)).status,400,query);
      assert.equal(readCalls,calls,"Invalid query must not enter DAO");
    }
    assert.equal((await http.get(`/${fx.a}?limit=1`)).status,400);
    for (const limit of [1,100]) assert.deepEqual((await http.get(`?limit=${limit}`)).body.page,{limit,hasMore:false,nextCursor:null});
    const detail = (await http.get(`/${fx.a}`)).body.project as ProjectReadDto;
    const cursor = fx.codec.encode({projectId:fx.a,principalId:"AUDITOR",limit:20},detail);
    const boundary = await http.get(`?cursor=${cursor}`);
    assert.equal(boundary.status,200); assert.deepEqual(boundary.body.items,[]);
    assert.equal((await http.get(`?cursor=${cursor}&limit=1`)).status,409);
    assert.equal((await http.get(`?cursor=${cursor}`,fx.auth("DEVELOPER"))).status,409);
    assert.equal((await http.get(`?cursor=${cursor}`,fx.auth("AUDITOR",fx.b))).status,409);
    assert.equal((await http.get(`?cursor=${cursor}`,fx.auth("AUDITOR",fx.a,"non-member"))).status,403);
    assert.equal((await http.get(`?cursor=${cursor.slice(0,-1)}${cursor.endsWith("a")?"b":"a"}`)).status,400);
    const expired = new ProjectReadCursorCodec((data)=>fx.core.authenticator.signProjectReadCursor(data),()=>Date.now()-900001).encode({projectId:fx.a,principalId:"AUDITOR",limit:20},detail);
    assert.equal((await http.get(`?cursor=${expired}`)).status,409);
  } finally {fx.store.readProjectProjection=read;await http.stop();}
}

describe("Dashboard P1 Project reader — memory and HTTP",() => {
  it("matches DTO, scope, role, transport, bounds and authenticated cursor contract",async() => {await contract(await fixture(new SoftwareFactoryControlPlaneStore()));});
  it("preserves all memory maps and nested objects; response mutation and failing reads cannot change source",async() => {
    const store = new SoftwareFactoryControlPlaneStore(()=>new Date("2026-11-14T00:00:00.123Z")); const fx = await fixture(store);
    const original = memorySnapshot(store);
    const session=structuredClone(store.getCurrentRlsSession());
    // Trap old methods: an independent reader cannot borrow a write transaction or recovery path.
    const forbidden = () => {throw new Error("forbidden side effect/private detail");};
    store.withRlsTransaction = forbidden;
    store.getProjectMembership = forbidden;
    store.getProjectById = forbidden;
    store.getProjectBudgetSnapshot = forbidden;
    const first = await fx.core.readProjectProjection(fx.auth(),fx.a);
    assert.deepEqual(await fx.core.readProjectProjection(fx.auth(),fx.a),first);
    assert.ok("project" in first); if ("project" in first) first.project.name = "mutated response";
    const next = await fx.core.readProjectProjection(fx.auth(),fx.a);
    assert.ok("project" in next); if ("project" in next) assert.equal(next.project.name,`Actual project ${fx.a}`);
    await expectError(fx.core.readProjectProjection(fx.auth(),fx.b),403);
    await expectError(fx.core.readProjectProjection(fx.auth(),undefined,new URLSearchParams("limit=101")),400);
    assert.equal(memorySnapshot(store),original);
    assert.deepEqual(store.getCurrentRlsSession(),session);
    const maps = store as unknown as {projects:Map<string,{name:string}>};
    maps.projects.get(fx.a)!.name = "x".repeat(1048577);
    const oversized = memorySnapshot(store);
    await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),500);
    assert.equal(memorySnapshot(store),oversized);
    maps.projects.delete(fx.a); // Inconsistent authorized fixture: no foreign-project existence lookup.
    await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),404);
  });
  it("requires fresh persisted membership and rejects inherited transaction contexts",async() => {
    const store = new SoftwareFactoryControlPlaneStore(); const fx = await fixture(store);
    await expectError(store.withRlsTransaction(fx.scope,()=>fx.core.readProjectProjection(fx.auth(),fx.a)),500);
    (store as unknown as {projectMemberships:Map<string,unknown>}).projectMemberships.delete(`${fx.a}:AUDITOR`);
    await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),403);
  });
  it("bounds a cold stalled startup and cleans up its socket",async()=>{
    const sockets=new Set<Socket>();
    const server=createServer(socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("data",()=>{});});
    await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
    const address=server.address();assert.ok(address && typeof address!=="string");
    const pool=new PostgresRuntimePool({host:"127.0.0.1",port:address.port,database:"unused",user:"unused",sslMode:"disable",connectTimeoutMs:10000,maxConnections:1});
    try {
      const started=Date.now();
      await assert.rejects(pool.withReadOnlyRlsTransaction({currentProjectId:randomUUID(),currentPrincipalId:"unused",currentRole:"core_api_service"},async()=>null));
      assert.ok(Date.now()-started<1700);
      assert.equal(pool.getStats().totalConnections,0);assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);
    }finally{await pool.close();for(const socket of sockets)socket.destroy();await new Promise<void>((r,e)=>server.close(error=>error?e(error):r()));}
  });
  it("preserves microseconds, rejects noncanonical timestamp payloads and binds cursor purpose",() => {
    assert.equal(readTimestamp("2026-11-14T00:00:00.123Z"),"2026-11-14T00:00:00.123000Z");
    assert.throws(()=>readTimestamp("2026-02-30T00:00:00.000000Z"));
    const core = new CoreApiService(new SoftwareFactoryControlPlaneStore());
    const codec = new ProjectReadCursorCodec((s)=>core.authenticator.signProjectReadCursor(s));
    const id=randomUUID(); const row={projectId:id,slug:"s",name:"n",defaultBranch:"main",createdAt:"2026-11-14T00:00:00.123456Z",updatedAt:"2026-11-14T00:00:00.123456Z"};
    const encoded=codec.encode({projectId:id,principalId:"p",limit:20},row);
    assert.equal(codec.decode(encoded).anchor.updatedAt,row.updatedAt);
    const bad=JSON.parse(Buffer.from(encoded.split(".")[0]!,"base64url").toString()) as {kind:string}; bad.kind="tasks";
    const payload=Buffer.from(JSON.stringify(bad)).toString("base64url");
    assert.throws(()=>codec.decode(`${payload}.${core.authenticator.signProjectReadCursor(payload)}`));
    assert.throws(()=>codec.decode(encoded+"="));
  });
});

const config=buildPostgresPoolConfigFromEnv();
async function contents(pool: PostgresRuntimePool,fx:Fx) {
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
async function catalog(pool:PostgresRuntimePool) {
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
describe("Dashboard P1 Project reader — real PostgreSQL",() => {
  it("HTTP parity, enforced read-only flags, SELECT-only DAO, full content equality and unchanged catalog",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required; required PG16/17 CI supplies it");return;}
    const pool=new PostgresRuntimePool(config);const repo=new PostgresControlPlaneRepository(pool);
    try {
      const fx=await fixture(repo);
      const task=randomUUID(),lease=randomUUID();
      await pool.withRlsTransaction(fx.scope,async()=>{
        await pool.queryInActiveTx("INSERT INTO tasks(task_id,project_id,title,task_contract_json,status,base_main_commit_hash) VALUES($1,$2,'reader lease fixture','{}','Ready',repeat('a',40));",[task,fx.a]);
        await pool.queryInActiveTx("INSERT INTO task_leases(lease_id,project_id,task_id,attempt_no,lease_epoch,worker_id,status,task_execution_idempotency_key,expires_at) VALUES($1,$2,$3,1,1,'reader-worker','ACTIVE',repeat('b',64),clock_timestamp()+interval '1 hour');",[lease,fx.a,task]);
        await pool.queryInActiveTx("INSERT INTO budget_denial_intents(intent_id,project_id,outer_xid,payload_json) VALUES($1,$2,pg_current_xact_id(),'{\"violation\":{\"scope\":\"PROJECT_TOKENS\",\"limit\":1,\"usage\":2,\"reason\":\"reader test denial\",\"taskId\":null},\"preflight\":null}');",[randomUUID(),fx.a]);
      });
      const before=await contents(pool,fx),schema=await catalog(pool);
      const rawQuery=pool.queryInActiveTx.bind(pool);
      const queries:string[]=[];
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{queries.push(sql);return rawQuery(sql,params);}) as typeof pool.queryInActiveTx;
      await contract(fx);
      assert.ok(queries.length>3);
      for(const sql of queries){assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/SELECT \*|\b(UPDATE|INSERT|DELETE|CALL|FOR UPDATE|pg_advisory)\b/i);}
      queries.length=0;
      pool.queryInActiveTx=rawQuery;
      assert.equal(await contents(pool,fx),before);
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{queries.push(sql);return rawQuery(sql,params);}) as typeof pool.queryInActiveTx;
      const forbidden=()=>{throw new Error("forbidden recovery/write handler secret");};
      repo.withRlsTransaction=forbidden;repo.getProjectMembership=forbidden;repo.getProjectById=forbidden;repo.getProjectBudgetSnapshot=forbidden;repo.recoverBudgetDenials=forbidden;
      const result=await fx.core.readProjectProjection(fx.auth(),fx.a);
      assert.ok("project" in result);
      assert.equal(queries.length,3);
      for(const sql of queries){assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/SELECT \*|\b(UPDATE|INSERT|DELETE|CALL|FOR UPDATE|pg_advisory)\b/i);}
      assert.match(queries[2]!,/ORDER BY updated_at DESC, project_id DESC LIMIT \$4/);
      assert.equal(pool.getActiveTxSession(),null);
      await pool.withReadOnlyRlsTransaction(fx.scope,async(snapshot)=>{
        assert.match(snapshot,/\.\d{6}Z$/);
        const flags=await rawQuery("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_user,current_app_project_id() AS project,current_app_principal_id() AS principal;");
        assert.deepEqual(flags.rows[0],{ro:"on",iso:"repeatable read",statement:"2s",lock:"250ms",current_user:"app_runtime",project:fx.a,principal:"AUDITOR"});
        assert.throws(()=>pool.afterTransactionEnd(async()=>{throw new Error("must not run");}),/cannot register/);
        await assert.rejects(pool.withRlsTransaction(fx.scope,async()=>null),/Cannot nest/);
        await assert.rejects(pool.runAutonomousRlsTransaction(fx.scope,async()=>null),/cannot open/);
      });
      await assert.rejects(pool.withReadOnlyRlsTransaction(fx.scope,async()=>{await rawQuery("UPDATE projects SET name='forbidden' WHERE project_id=$1;",[fx.a]);}),(e:unknown)=>(e as {sqlState?:string}).sqlState==="25006");
      await pool.withRlsTransaction(fx.scope,async()=>{await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),500);});
      assert.equal(await contents(pool,fx),before);
      assert.equal(await catalog(pool),schema);
      assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);
    }finally{await pool.close();}
  });
  it("keeps auth and DTO on one snapshot across a concurrent committed writer; rechecks next request",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),writer=new PostgresRuntimePool(config);
    try {
      const fx=await fixture(new PostgresControlPlaneRepository(pool));
      const raw=pool.queryInActiveTx.bind(pool);let injected=false;
      pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{
        const result=await raw(sql,params);
        if(!injected && sql.startsWith("SELECT member_role")){
          injected=true;
          await writer.withRlsTransaction({...fx.scope,currentRole:"system_admin_role"},async()=>{
            // Fixture writer uses existing connection administrator; runtime grants remain unchanged.
            await writer.queryInActiveTx("SET LOCAL ROLE NONE;");
            await writer.queryInActiveTx("UPDATE projects SET name='committed concurrent name',updated_at=clock_timestamp() WHERE project_id=$1;",[fx.a]);
            await writer.queryInActiveTx("DELETE FROM project_memberships WHERE project_id=$1 AND principal_id='AUDITOR';",[fx.a]);
          });
        }
        return result;
      }) as typeof pool.queryInActiveTx;
      const result=await fx.core.readProjectProjection(fx.auth(),fx.a);
      assert.ok("project" in result);if("project" in result)assert.equal(result.project.name,`Actual project ${fx.a}`);
      await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),403);
      const next=await fx.core.readProjectProjection(fx.auth("DEVELOPER"),fx.a);
      assert.ok("project" in next);if("project" in next){assert.equal(next.project.name,"committed concurrent name");assert.ok(result.fetchedAt < next.project.updatedAt);}
    }finally{await pool.close();await writer.close();}
  });
  it("returns generic errors for handler, DTO, serialization and lock faults with zero business delta",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool(config),writer=new PostgresRuntimePool(config);
    try {
      const repo=new PostgresControlPlaneRepository(pool),fx=await fixture(repo);
      const before=await contents(pool,fx);const raw=pool.queryInActiveTx.bind(pool);
      const http=await start(fx);
      try {
        for(const mode of ["handler","dto"]){
          pool.queryInActiveTx=(async(sql:string,params:readonly unknown[]=[])=>{
            const result=await raw(sql,params);
            if(sql.includes("AS created_at")){
              if(mode==="handler")throw new Error("private SQL/credential/path failure must not leak");
              result.rows[0]!.created_at="invalid source timestamp";
            }
            return result;
          }) as typeof pool.queryInActiveTx;
          const response=await http.get(`/${fx.a}`);
          assert.equal(response.status,500);assert.deepEqual(response.body,{error_code:"ERR_READ_PROJECTION_FAILED"});
          pool.queryInActiveTx=raw;
          assert.equal(await contents(pool,fx),before);
        }
        let release!:()=>void,entered!:()=>void;
        const wait=new Promise<void>(r=>{release=r;});const held=new Promise<void>(r=>{entered=r;});
        const lock=writer.withRlsTransaction({...fx.scope,currentRole:"system_admin_role"},async()=>{
          await writer.queryInActiveTx("SET LOCAL ROLE NONE;");
          await writer.queryInActiveTx("LOCK TABLE projects IN ACCESS EXCLUSIVE MODE;");
          entered();await wait;
        });
        try {await held;const start=Date.now();assert.equal((await http.get(`/${fx.a}`)).status,500);assert.ok(Date.now()-start<1500);}
        finally{release();await lock;}
        assert.equal(await contents(pool,fx),before);
        // Administrator changes fixture data; this is outside reader comparisons.
        await writer.withRlsTransaction({...fx.scope,currentRole:"system_admin_role"},async()=>{
          await writer.queryInActiveTx("SET LOCAL ROLE NONE;");
          await writer.queryInActiveTx("UPDATE projects SET name=$2 WHERE project_id=$1;",[fx.a,"x".repeat(1048577)]);
        });
        const oversized=await contents(pool,fx);
        const response=await http.get(`/${fx.a}`);assert.equal(response.status,500);assert.deepEqual(response.body,{error_code:"ERR_READ_PROJECTION_FAILED"});
        assert.equal(await contents(pool,fx),oversized);
        assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);
      }finally{pool.queryInActiveTx=raw;await http.stop();}
    }finally{await pool.close();await writer.close();}
  });
  it("bounds acquire, statement and whole-operation time; rolls back errors and permits a clean next request",async(t)=>{
    if(!config){t.skip("Real PostgreSQL required");return;}
    const pool=new PostgresRuntimePool({...config,maxConnections:1});
    try {
      const fx=await fixture(new PostgresControlPlaneRepository(pool));
      const before=await contents(pool,fx);
      await assert.rejects(pool.withReadOnlyRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("SELECT pg_sleep(3);");}),(e:unknown)=>(e as {sqlState?:string}).sqlState==="57014");
      const started=Date.now();
      await assert.rejects(pool.withReadOnlyRlsTransaction(fx.scope,async()=>{await pool.queryInActiveTx("SELECT pg_sleep(1);");},Date.now()+80));
      assert.ok(Date.now()-started<1000);
      let release!:()=>void,entered!:()=>void;
      const enteredPromise=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});
      const busy=pool.withRlsTransaction(fx.scope,async()=>{entered();await hold;});
      try {
        await enteredPromise;const start=Date.now();
        await expectError(fx.core.readProjectProjection(fx.auth(),fx.a),500);
        assert.ok(Date.now()-start>=850 && Date.now()-start<2000);
        assert.equal(pool.getStats().waitingCount,0);
      }finally{release();await busy;}
      assert.ok("project" in await fx.core.readProjectProjection(fx.auth(),fx.a));
      assert.equal(await contents(pool,fx),before);
      assert.equal(pool.getStats().activeConnections,0);assert.equal(pool.getStats().waitingCount,0);assert.equal(pool.getActiveTxSession(),null);
      // Racing cold acquisitions must not exceed configured maxConnections.
      const cold=new PostgresRuntimePool({...config,maxConnections:1});
      try {
        await Promise.all(Array.from({length:6},()=>cold.withReadOnlyRlsTransaction(fx.scope,async()=>{await cold.queryInActiveTx("SELECT 1 AS bounded;");})));
        assert.equal(cold.getStats().totalConnections,1);assert.equal(cold.getStats().activeConnections,0);
      }finally{await cold.close();}
    }finally{await pool.close();}
  });
});
