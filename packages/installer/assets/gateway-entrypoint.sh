#!/bin/sh
set -eu
# Replace only our resolver marker. Never expand nginx's $variables.
resolvers=$(awk '
function ipv4(s, a,n,i) {
 n=split(s,a,"."); if(n!=4)return 0;
 for(i=1;i<=n;i++) if(a[i]!~/^[0-9]+$/ || length(a[i])>3 || a[i]+0>255 || (length(a[i])>1 && substr(a[i],1,1)=="0"))return 0;
 return 1
}
function ipv6(s, a,n,i,count,copy,compressed) {
 if(s!~/:/ || s~/[^0-9a-fA-F:.]/ || s~/:::/)return 0;
 copy=s; compressed=gsub(/::/,"X",copy); if(compressed>1)return 0;
 if(!compressed && (s~/^:/ || s~/:$/))return 0;
 n=split(s,a,":"); count=0;
 for(i=1;i<=n;i++) {
  if(a[i]=="")continue;
  if(a[i]~/\./) {if(i!=n || !ipv4(a[i]))return 0; count+=2}
  else {if(a[i]!~/^[0-9a-fA-F]+$/ || length(a[i])>4)return 0; count++}
 }
 return compressed ? count<8 : count==8
}
$1=="nameserver" {
 if(ipv4($2))address=$2;
 else if(ipv6($2))address="[" $2 "]";
 else next;
 if(!seen[address]++) {printf "%s%s",sep,address; sep=" "}
}
' "${OURS_RESOLV_CONF:-/etc/resolv.conf}")
if [ -z "$resolvers" ]; then echo 'Gateway: no valid runtime DNS nameserver' >&2; exit 1; fi
umask 077
config=$(mktemp /tmp/ours-nginx.XXXXXX)
trap 'rm -f "$config"' EXIT HUP INT TERM
sed "s/@@OURS_RESOLVERS@@/$resolvers/g" "${OURS_NGINX_TEMPLATE:-/etc/nginx/ours.conf.template}" > "$config"
nginx -t -c "$config"
# nginx opens the config before the shell exits; exec leaves this file in tmpfs.
trap - EXIT HUP INT TERM
exec nginx -c "$config" -g 'daemon off;'
