# Atualizacao pontual 6.8.41 — Pix Mercado Pago

Este pacote deve ser aplicado somente sobre a versao 6.8.40.

## Arquivo que vai para o GitHub

Substitua somente o arquivo `server.js` do seu repositorio pelo `server.js` deste pacote.

O arquivo `ATUALIZAR.md` e apenas este manual e nao precisa ser enviado ao GitHub.

## Configuracao no Render

Em **Environment**, adicione:

```text
MERCADOPAGO_ACCESS_TOKEN=SEU_ACCESS_TOKEN
MERCADOPAGO_ENV=production
PUBLIC_URL=https://endereco-do-seu-site.onrender.com
```

- Cole somente o Access Token, sem a palavra `Bearer` e sem aspas.
- Nunca coloque o Access Token no GitHub, em arquivos publicos ou em mensagens.
- Para testar antes da producao, use o token de teste e `MERCADOPAGO_ENV=sandbox`.
- A conta Mercado Pago precisa ter uma chave Pix cadastrada e as credenciais de producao ativadas.
- Mantenha as variaveis `PAGBANK_TOKEN`, `PAGBANK_ENV` e `PAGBANK_SOFT_DESCRIPTOR`, pois o boleto continua sendo processado pelo PagBank.

Nao e preciso alterar o banco manualmente. A aplicacao cria as novas colunas ao iniciar.

## Publicacao e teste

1. Envie o novo `server.js` ao GitHub.
2. No Render, confirme as variaveis acima e execute **Deploy latest commit**.
3. Abra `/health` no final do endereco do seu site.
4. Confirme `version: 6.8.41`, `mercadoPago.configured: true` e `mercadoPago.environment: production`.
5. Faca um Pix real de valor baixo, por exemplo R$ 2,00.
6. O QR Code e o codigo Copia e Cola devem aparecer dentro da plataforma; o status deve mudar automaticamente depois do pagamento.
7. Confirme tambem que o boleto continua abrindo o checkout do PagBank.

O CPF/CNPJ informado para criar o Pix e enviado ao Mercado Pago somente durante a cobranca e nao fica armazenado pela plataforma.
