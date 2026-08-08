# Atualização pontual — NZN Quiz 6.9.1

Este pacote deve ser aplicado sobre a versão 6.8.41.

## Arquivo que vai para o GitHub

Suba somente:

```text
server.js
```

O arquivo `ATUALIZAR.md` é apenas este manual e não precisa ser enviado.

## Como atualizar

1. Abra o repositório conectado ao Render.
2. Substitua o `server.js` 6.8.41 pelo arquivo deste pacote.
3. Faça um commit com a mensagem `Atualizar NZN Quiz para 6.9.1`.
4. Aguarde o deploy ou use **Deploy latest commit** no Render.
5. Abra `/health` e confirme `"version":"6.9.1"`.
6. Atualize a página com `Ctrl + F5`.

## O que conferir

1. `/painel/quizzes` abre diretamente.
2. O endereço antigo `/?admin=1` muda para `/painel`.
3. Ao iniciar um quiz, a barra mostra `/apresentador/CODIGO` e a apresentação aparece.
4. Faça o mesmo teste com uma nuvem de palavras.
5. Crie uma sala e confira `/sala/CODIGO` e `/tela/CODIGO`.
6. Teste o Pix Mercado Pago e o boleto PagBank.

## Não precisa alterar

- banco PostgreSQL;
- variáveis do Mercado Pago ou PagBank;
- `render.yaml`;
- credenciais administrativas.

O backup completo da 6.8.41 deve ser mantido como opção de retorno.
