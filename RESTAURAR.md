# Restaurar o NZN Quiz para a versão 6.8.41

Este pacote remove o novo visual da versão 6.9.0 e restaura a interface anterior da versão 6.8.41.

## O que subir no GitHub

Suba somente:

```text
server.js
```

O arquivo `RESTAURAR.md` é apenas este manual e não precisa ser enviado.

## Passo a passo

1. Abra o repositório do GitHub conectado ao Render.
2. Substitua o `server.js` atual pelo arquivo deste pacote.
3. Faça o commit com a mensagem `Restaurar NZN Quiz 6.8.41`.
4. Aguarde o deploy automático ou escolha **Deploy latest commit** no Render.
5. Abra `https://SEU-ENDERECO.onrender.com/health`.
6. Confirme que aparece `"version":"6.8.41"`.

## Não altere

- as variáveis do Mercado Pago;
- as variáveis do PagBank;
- o banco PostgreSQL;
- o `render.yaml`;
- suas credenciais administrativas.

O Pix Mercado Pago continuará mostrando o QR Code dentro da plataforma e o boleto continuará sendo processado pelo PagBank.

Depois do deploy, pressione `Ctrl + F5` para o navegador descartar o visual 6.9.0 que possa ter ficado em cache.
