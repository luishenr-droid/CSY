# PagBank — NZN 6.8.33

O módulo Apoie o NZN está configurado para criar novas transações somente por **Pix** e **boleto**.

No Render mantenha:

- `PAGBANK_TOKEN`
- `PAGBANK_ENV=sandbox` durante os testes; depois use `production`.
- `PUBLIC_URL` com o endereço público correto do NZN.

O NZN gera um protocolo exclusivo por transação e acompanha o status através do webhook `/api/pagbank/webhook`.

Não envie o token do PagBank pelo chat e não salve o token no GitHub.
