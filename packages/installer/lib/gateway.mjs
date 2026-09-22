/** One public URL; fixed same-origin service paths are never supplied by a peer. */
export const GATEWAY_SERVICES = Object.freeze({daemon:'/daemon',cowork:'/cowork',telegram:'/tg-connector',messenger:'/messenger'});
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
  resolver 127.0.0.11 valid=5s ipv6=off;
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
    location / { return 404; }
  }
}
`;
}
