# NZN Quiz 6.8.38 — Correção PagBank Sandbox

Base: NZN Quiz 6.8.37.

## Corrigido

- O token agora é normalizado caso tenha sido colado com `Bearer` ou entre aspas.
- O sandbox aceita webhook sem `x-authenticity-token`, mas continua validando quando o cabeçalho é enviado.
- Em produção, a assinatura do webhook continua obrigatória.
- Mensagens de erro do PagBank agora mostram o campo, o código e a causa retornada pela API.
- Erros 401 e 403 orientam sobre token incompatível ou falta de permissão/homologação.
- O endpoint `/health` informa o ambiente e o modo de verificação, sem expor o token.
- O Checkout explicita `customer_modifiable: true` e mantém apenas Pix ou boleto conforme a escolha.

## Compatibilidade

Nenhuma funcionalidade da versão 6.8.37 foi removida. A integração continua usando:

- Sandbox: `https://sandbox.api.pagseguro.com`
- Produção: `https://api.pagseguro.com`
- Checkout: `POST /checkouts`
- Consulta: `GET /checkouts/{checkout_id}`

