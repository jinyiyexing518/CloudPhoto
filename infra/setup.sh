#!/usr/bin/env bash
# =============================================================================
# CloudPhoto — Singapore VM Setup Script
# Run as root on a fresh Ubuntu 22.04 LTS VM:
#   wget -O setup.sh https://raw.githubusercontent.com/.../infra/setup.sh
#   bash setup.sh YOUR_DOMAIN
# =============================================================================
set -euo pipefail

DOMAIN="${1:-cloudphotos.top}"
EMAIL="admin@${DOMAIN}"   # Let's Encrypt notifications

echo "==> [1/5] System update"
apt-get update -y && apt-get upgrade -y

echo "==> [2/5] Install Nginx + Certbot"
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> [3/5] Temporary HTTP-only Nginx config (needed for certbot)"
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
certbot certonly --nginx \
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
echo "    Certbot will auto-renew before expiry — no action needed."
