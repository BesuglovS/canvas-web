#!/bin/bash
# ==========================================================================
# fix-canvas-nginx.sh — маршрутизировать /sandbox/*.php canvas на PHP-FPM
# (сейчас всё проксируется на Node). Node использует этот эндпоинт для
# server-to-server проверки SSO-сессии.
# ==========================================================================
set -euo pipefail

CONF=/etc/nginx/sites-enabled/canvas.nayanovaacademy.ru
python3 - "$CONF" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if 'php8.1-fpm.sock' in s:
    print('php-fpm location already present')
else:
    php = '''
    # PHP-эндпоинт проверки SSO для Node (server-to-server).
    location ~ ^/sandbox/.*\\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.1-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_read_timeout 15s;
    }
'''
    # вставить перед "location ~ /\\." (скрытые файлы), иначе перед location /
    marker = '    # Запрет доступа к скрытым файлам'
    if marker in s:
        s = s.replace(marker, php + '\n' + marker, 1)
    else:
        # перед первым location /
        idx = s.find('    location / {')
        s = s[:idx] + php + '\n' + s[idx:]
    print('inserted php-fpm location')

open(p, 'w', encoding='utf-8').write(s)
PY

nginx -t
systemctl reload nginx
echo done
