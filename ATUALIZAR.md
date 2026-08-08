# Atualização pontual — NZN Quiz 6.9.2

Este pacote deve ser aplicado sobre a versão 6.9.1.

## Arquivo para o GitHub

Suba somente:

```text
server.js
```

O arquivo `ATUALIZAR.md` é apenas este manual.

## Como atualizar

1. Substitua o `server.js` do repositório pelo arquivo deste pacote.
2. Faça um commit com a mensagem `Atualizar interface para 6.9.2`.
3. Aguarde o deploy do Render.
4. Abra `/health` e confirme `"version":"6.9.2"`.
5. Pressione `Ctrl + F5` para limpar o cache.

## Conferência

1. Entre em `/painel`: o menu dos módulos não deve aparecer nessa visão inicial.
2. Abra `/painel/quizzes`: o menu superior deve aparecer.
3. Confira login, quizzes, editores, resultados, usuários, apoios, conta, FAQ e suporte.
4. Inicie um quiz e uma nuvem de palavras.
5. Confirme que apresentador, participante, pódio e ranking continuam com o mesmo visual da versão 6.9.1.
6. Teste Pix Mercado Pago e boleto PagBank.

Não é necessário alterar banco, variáveis do Render ou credenciais.
