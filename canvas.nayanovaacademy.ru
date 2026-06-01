upstream canvas_node {
    server 127.0.0.1:3000;
}

server {
    listen 80;
    server_name canvas.nayanovaacademy.ru;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name canvas.nayanovaacademy.ru;

    ssl_certificate     /etc/ssl/certs/nayanovaacademy.ru/cert2.pem;
    ssl_certificate_key /etc/ssl/private/nayanovaacademy.ru/key2.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    root /var/www/canvas.nayanovaacademy.ru/public;

    access_log /var/log/nginx/canvas.nayanovaacademy.ru.access.log;
    error_log  /var/log/nginx/canvas.nayanovaacademy.ru.error.log;

    # WebSocket и Socket.IO проксируются на Node.js
    location /socket.io/ {
        proxy_pass http://canvas_node;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    # Прокси на Node.js приложение (все остальные запросы)
    location / {
        proxy_pass http://canvas_node;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        client_max_body_size 10m;
    }

    # Статические файлы отдаём напрямую с кешированием
    location ~* \.(css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Запрет доступа к скрытым файлам
    location ~ /\. {
        deny all;
        access_log off;
        log_not_found off;
    }
}