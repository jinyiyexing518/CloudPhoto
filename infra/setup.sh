#!/usr/bin/env bash
# =============================================================================
# CloudPhoto — Singapore VM Setup Script
# Run as root on a fresh Ubuntu 22.04 LTS VM:
#   wget -O setup.sh https://raw.githubusercontent.com/.../infra/setup.sh
#   bash setup.sh YOUR_DOMAIN --authenticator dns-PROVIDER \
#     --dns-PROVIDER-credentials /root/provider.ini
# =============================================================================
set -euo pipefail

DOMAIN="${1:-cloudphotos.top}"
shift $(( $# > 0 ? 1 : 0 ))
CERTBOT_DNS_ARGS=("$@")
EMAIL="admin@${DOMAIN}"   # Let's Encrypt notifications

if [ "${#CERTBOT_DNS_ARGS[@]}" -eq 0 ]; then
    cat >&2 <<EOF
ERROR: www.${DOMAIN} uses split DNS, so its certificate must use an
automatable DNS-01 plugin. Install your provider's Certbot DNS plugin and pass
its authenticator/credential arguments after the domain. HTTP-01 is unsafe
because validation may resolve to Azure Static Web Apps.
EOF
    exit 2
fi

HAS_DNS_PLUGIN=false
EXPECT_DNS_AUTHENTICATOR=false
for arg in "${CERTBOT_DNS_ARGS[@]}"; do
    case "${arg}" in
        --manual|--nginx|--webroot|--standalone)
            echo "ERROR: ${arg} cannot safely renew a split-DNS www certificate." >&2
            exit 2
            ;;
    esac
    if [ "${EXPECT_DNS_AUTHENTICATOR}" = "true" ]; then
        case "${arg}" in
            dns-*) HAS_DNS_PLUGIN=true ;;
            *)
                echo "ERROR: --authenticator must select a dns-* plugin." >&2
                exit 2
                ;;
        esac
        EXPECT_DNS_AUTHENTICATOR=false
        continue
    fi
    case "${arg}" in
        --authenticator) EXPECT_DNS_AUTHENTICATOR=true ;;
        --authenticator=dns-*) HAS_DNS_PLUGIN=true ;;
        --authenticator=*)
            echo "ERROR: --authenticator must select a dns-* plugin." >&2
            exit 2
            ;;
    esac
done
if [ "${EXPECT_DNS_AUTHENTICATOR}" = "true" ]; then
    echo "ERROR: --authenticator requires a dns-* plugin name." >&2
    exit 2
fi
if [ "${HAS_DNS_PLUGIN}" != "true" ]; then
    echo "ERROR: Certbot arguments must select an installed DNS authenticator." >&2
    exit 2
fi

echo "==> [1/5] System update"
apt-get update -y && apt-get upgrade -y

echo "==> [2/5] Install Nginx + Certbot"
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> [3/5] Temporary HTTP-only Nginx config"
cat > /etc/nginx/sites-available/cloudphoto <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN} cn.${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'ok'; }
}
EOF

ln -sf /etc/nginx/sites-available/cloudphoto /etc/nginx/sites-enabled/cloudphoto
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> [4/5] Issue Let's Encrypt certificate for ${DOMAIN}"
certbot certonly "${CERTBOT_DNS_ARGS[@]}" \
    -d "${DOMAIN}" \
    -d "www.${DOMAIN}" \
    -d "cn.${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    --email "${EMAIL}"

echo "==> [4b/5] Install full proxy Nginx config"
sed "s/YOUR_DOMAIN/${DOMAIN}/g" "$(dirname "$0")/nginx.conf" \
    > /etc/nginx/sites-available/cloudphoto
nginx -t && systemctl reload nginx

echo "==> [5/5] Enable auto-renewal (runs twice daily via systemd timer)"
systemctl enable --now certbot.timer
# Verify: systemctl status certbot.timer

echo ""
echo "✅  Done!  https://${DOMAIN} is live."
echo "    Certificate SANs: ${DOMAIN}, www.${DOMAIN}, cn.${DOMAIN}"
echo "    Certbot will auto-renew with the configured DNS plugin before expiry."
