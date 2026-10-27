/** One public URL; fixed same-origin service paths are never supplied by a peer. */
export const GATEWAY_SERVICES = Object.freeze({daemon:'/daemon',cowork:'/cowork',telegram:'/tg-connector',messenger:'/messenger'});
/** Notifications run inside the Messenger container when its runtime ships the service. */
export const NOTIFICATIONS_PORT=49677;
export function serverBase(value) {
  if(typeof value!=='string'||/[\s\\?#]/.test(value)||!/^https?:\/\//.test(value))throw new Error('Server URL must be an HTTP or HTTPS base URL');
  const url=new URL(value);
  if(url.username||url.password)throw new Error('Server URL cannot contain credentials');
  return url.origin+url.pathname.replace(/\/+$/,'');
}
export function gatewayDiscovery(record) {
  return {schema:1,instanceId:record.instanceId,services:GATEWAY_SERVICES,capabilities:['ours.gateway-v1','cowork.http-management-v1']};
}
export function validateGatewayDiscovery(url,value,credentialPath) {
  const base=serverBase(url);
  if(value?.schema!==1||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.instanceId??'')
    ||!Array.isArray(value.capabilities)||!value.capabilities.includes('ours.gateway-v1')||!value.capabilities?.includes('cowork.http-management-v1')
    ||Object.keys(GATEWAY_SERVICES).some(key=>value.services?.[key]!==GATEWAY_SERVICES[key]))throw new Error('Incompatible server gateway discovery');
  return {serverUrl:base,endpoint:base+'/daemon',expectedInstanceId:value.instanceId,credentialPath};
}
export function gatewayAddress(record) {
  const base = serverBase(record.gateway?.serverUrl ?? `http://127.0.0.1:${record.port}`);
  const url = new URL(base);
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(url.pathname)) throw new Error('Gateway base path must contain plain URL path segments');
  return { base, origin: url.origin, prefix: url.pathname.replace(/\/$/, '') };
}
export function gatewayCompose(record) {
  const { origin, prefix } = gatewayAddress(record);
  return `services:
  daemon:
    ports: !reset []
  telegram:
    ports: !reset []
    environment:
      OURS_TG_CONTROL_HOST: "0.0.0.0"
  cowork:
    ports: !reset []
    environment:
      OURS_COWORK_HTTP_MANAGEMENT: "1"
      OURS_COWORK_PUBLIC_ORIGIN: ${JSON.stringify(origin)}
  messenger:
    ports: !reset []
    environment:
      OURS_MESSENGER_PUBLIC_ORIGIN: ${JSON.stringify(origin)}
      OURS_MESSENGER_BASE_PATH: ${JSON.stringify(prefix + "/messenger/")}
  gateway:
    image: "\${OURS_GATEWAY_IMAGE:-${record.project}:gateway}"
    build:
      context: .
      dockerfile: Dockerfile.gateway
    user: "101:101"
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    tmpfs: ["/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777"]
    networks: [ours]
    ports:
      - {target: 8080, published: "${record.port}", host_ip: "127.0.0.1"}
    restart: unless-stopped
    stop_signal: SIGTERM
    stop_grace_period: 10s
    healthcheck:
      test: [CMD, wget, -q, -O, /dev/null, http://127.0.0.1:8080/healthz]
      interval: 5s
      timeout: 3s
      retries: 6
`;
}
export function gatewayNginx(record) {
  const { prefix: basePath } = gatewayAddress(record);
  const routes=[['daemon',3050],['cowork',record.coworkPort??3052],['telegram',3051],['messenger',8420]];
  const upstream=Object.fromEntries(routes);
  for(const port of Object.values(upstream))if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid gateway upstream port');
  const route=(name,servicePath)=> { const prefix=basePath+servicePath; return`location ${prefix}/ {
      set $upstream_${name} http://${name}:${upstream[name]};
      rewrite ^${prefix}/(.*)$ /$1 break;
      proxy_pass $upstream_${name};
      proxy_set_header Host $http_host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_read_timeout 300s;
    }`; };
  return `worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events { worker_connections 1024; }
http {
  access_log off;
  client_body_temp_path /tmp/client;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  proxy_next_upstream off;
  resolver @@OURS_RESOLVERS@@ valid=5s;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server {
    listen 8080;
    server_name _;
    client_max_body_size 64m;
    location = /healthz { return 200 'ok'; }
    location = ${basePath}/.well-known/ours { default_type application/json; return 200 '${JSON.stringify(gatewayDiscovery(record))}'; }
    location = / { return 302 ${basePath}/messenger/; }
    location = ${basePath}/daemon { return 308 ${basePath}/daemon/; }
    location = ${basePath}/cowork { return 308 ${basePath}/cowork/; }
    location = ${basePath}/tg-connector { return 308 ${basePath}/tg-connector/; }
    location = ${basePath}/messenger { return 308 ${basePath}/messenger/; }
    # Never publish the unauthenticated loopback browser RPC. Management has its
    # own application-level credential check and rejects browser-origin requests.
    location = ${basePath}/cowork/rpc { return 403; }
    location ${basePath}/cowork/management/ {
      client_max_body_size 1m;
      set $management http://cowork:${upstream.cowork};
      rewrite ^${basePath}/cowork/(.*)$ /$1 break;
      proxy_pass $management;
      proxy_set_header Host $http_host;
      proxy_http_version 1.1;
      proxy_read_timeout 60s;
    }
    ${route('daemon','/daemon')}
    ${route('cowork','/cowork')}
    # Telegram's control API is local-only; no unauthenticated remote proxy.
    location ${basePath}/tg-connector/ {
      auth_request /_server_auth;
      set $telegram http://telegram:3051;
      rewrite ^${basePath}/tg-connector/(.*)$ /$1 break;
      proxy_pass $telegram;
    }
    location = /_server_auth {
      internal;
      set $auth http://daemon:3050/identities;
      proxy_pass $auth;
      proxy_pass_request_body off;
      proxy_set_header Content-Length "";
      proxy_set_header X-Ours-Api-Token $http_x_ours_api_token;
    }
    ${route('messenger','/messenger')}
    location = ${basePath}/notifications { return 308 ${basePath}/notifications/; }
    # The service's own adapter authenticates again and holds the credential it injects.
    location ${basePath}/notifications/ {
      auth_request /_server_auth;
      set $notifications http://messenger:${NOTIFICATIONS_PORT};
      rewrite ^${basePath}/notifications/(.*)$ /$1 break;
      proxy_pass $notifications;
      proxy_set_header Host $http_host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_http_version 1.1;
      proxy_buffering off;
      proxy_read_timeout 300s;
    }
    location / { return 404; }
  }
}
`;
}

/** How long the gateway readiness probe keeps retrying a dependency that is still starting. */
export const GATEWAY_READINESS_WAIT_MS = 60_000;
const GATEWAY_READINESS_RETRY_MS = 1_000;
const READINESS_KIND = /^(EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|TIMEOUT|HTTP_[1-5][0-9][0-9]|INVALID|RPC_ERROR|CHECK_FAILED)$/;

/**
 * Node script the installer runs inside the daemon container to prove the
 * gateway serves the daemon and Cowork management with the installation's
 * credential. Services restored by an update may still be starting, so a
 * transient result (a 502/503/504 without an RPC error body, a request
 * timeout, a refused, reset or dropped connection — including one dropped
 * while the body is read — or a name not yet resolvable) is
 * retried until one total `deadlineMs` across every stage and attempt; each
 * request is capped to the time left. Anything else — a wrong instance,
 * 401/403, a well-formed RPC error under any status, any other status or an
 * invalid body — fails at once. The probe only reads; nothing else is retried. Output carries stage and a fixed kind only,
 * never the token or a response body.
 *
 * The output reports the last attempt's failure and the total attempt count,
 * with one diagnostic fallback: when the last attempt's request (or body) timed
 * out because the total deadline shortened its own limit, in a stage strictly
 * earlier than the previous reported failure, that attempt did not reach the
 * stage, so the previous failure's stage and kind are reported instead. This
 * does not imply that the earlier condition still holds. Every other timeout,
 * every other kind and permanent failures report themselves.
 */
export function gatewayReadinessScript({ base, instanceId, tokenPath = '/var/lib/ours/daemon-token',
  deadlineMs = GATEWAY_READINESS_WAIT_MS, retryMs = GATEWAY_READINESS_RETRY_MS }) {
  return `const fs=require('node:fs');const base=${JSON.stringify(base)};const instanceId=${JSON.stringify(instanceId)};
const tokenPath=${JSON.stringify(tokenPath)};const deadline=Date.now()+${Number(deadlineMs)};const retryMs=${Number(retryMs)};
const NET=['EAI_AGAIN','ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT'];
class Check extends Error{constructor(kind,transient,cut=false){super(kind);this.kind=kind;this.transient=transient;this.cut=cut;}}
const status=s=>new Check('HTTP_'+s,s===502||s===503||s===504);
// cut: the request's own 5s limit was shortened by the total deadline.
const request=async(path,options)=>{const remaining=deadline-Date.now(),cut=remaining<5000,left=Math.max(1,Math.min(5000,remaining));
  try{const r=await fetch(base+path,{...options,redirect:'error',signal:AbortSignal.timeout(left)});r.cut=cut;return r;}
  catch(e){const code=e?.cause?.code;if(NET.includes(code))throw new Check(code,true);if(e?.name==='TimeoutError'||e?.cause?.name==='TimeoutError')throw new Check('TIMEOUT',true,cut);throw new Check('CHECK_FAILED',false);}};
const json=async(path,options={})=>{const r=await request(path,options);
  if(!r.ok){let body;try{body=await r.json();}catch{}
    // A well-formed RPC error is the service's answer, whatever the status: never retried.
    if(body&&typeof body==='object'&&body.version===1&&body.error)throw new Check('RPC_ERROR',false);throw status(r.status);}
  // The request signal also bounds the body: a stalled body is a timeout, not an invalid answer.
  // A connection dropped mid-body is transport, not content; only a parse failure is invalid.
  try{return await r.json();}catch(e){if(e?.name==='TimeoutError'||e?.name==='AbortError')throw new Check('TIMEOUT',true,r.cut);
    const code=e?.cause?.code;if(NET.includes(code))throw new Check(code,true);throw new Check('INVALID',false);}};
const STAGES=['selection','unauthenticated-management','credential','authenticated-daemon','authenticated-management'];let stage='selection';
const attempt=async()=>{
  stage='selection';const selection=await json('/daemon/selection');
  if(selection?.instanceId!==instanceId)throw new Check('INVALID',false);
  stage='unauthenticated-management';
  const denied=await request('/cowork/management/rpc',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  await denied.body?.cancel();if(denied.status!==401)throw status(denied.status);
  stage='credential';let token;try{token=fs.readFileSync(tokenPath,'utf8').trim();}catch{throw new Check('CHECK_FAILED',false);}
  const headers={'x-ours-api-token':token,'content-type':'application/json'};
  stage='authenticated-daemon';const identities=await json('/daemon/identities',{headers});
  if(!Array.isArray(identities?.identities))throw new Check('INVALID',false);
  stage='authenticated-management';
  const result=await json('/cowork/management/rpc',{method:'POST',headers,body:JSON.stringify({version:1,id:'installer-readiness',method:'room.list',params:{}})});
  if(result?.version!==1||result.id!=='installer-readiness'||!Array.isArray(result.result)||result.error)throw new Check('INVALID',false);
};
(async()=>{let attempts=0,last=null;for(;;){attempts++;try{await attempt();return;}catch(e){
  const c=e instanceof Check?e:new Check('CHECK_FAILED',false);
  // Diagnostic fallback: only a deadline-cut TIMEOUT in a strictly earlier stage reports the previous failure.
  const seen=c.kind==='TIMEOUT'&&c.cut&&last&&STAGES.indexOf(stage)<STAGES.indexOf(last.stage)?last:{stage,kind:c.kind,transient:c.transient};
  if(!c.transient||Date.now()+retryMs>=deadline){process.stdout.write('gateway-readiness:'+seen.stage+':'+seen.kind+':'+attempts+(seen.transient?':transient':''));process.exitCode=1;return;}
  last=seen;await new Promise(r=>setTimeout(r,retryMs));}}})();`;
}

/** Operator text for a failed readiness probe; `undefined` when the output is not the probe's. */
export function describeGatewayReadiness(stdout) {
  const match = /^gateway-readiness:(selection|unauthenticated-management|credential|authenticated-daemon|authenticated-management):([A-Z0-9_]+):([0-9]{1,6})(:transient)?$/.exec(String(stdout).trim());
  if (!match || !READINESS_KIND.test(match[2])) return undefined;
  const [, stage, kind, attempts, transient] = match;
  const what = kind.startsWith('HTTP_') ? `HTTP ${kind.slice(5)}` : kind;
  return transient
    ? `${stage}, ${what}; still not ready after ${attempts} attempts over ${GATEWAY_READINESS_WAIT_MS / 1000}s`
    : `${stage}, ${what}`;
}
