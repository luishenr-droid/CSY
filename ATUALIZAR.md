# Atualizacao pontual 6.8.40 — Pix dentro da plataforma

Use este pacote somente sobre a versao 6.8.39.

## Arquivo que deve ser enviado ao GitHub

Substitua apenas:

```text
server.js
```

O arquivo `ATUALIZAR.md` e apenas este manual e nao precisa ser enviado.

## O que muda

- Pix com QR Code e codigo Copia e Cola dentro da plataforma.
- Contador de validade de 30 minutos.
- Consulta automatica do status e botao para atualizar imediatamente.
- CPF ou CNPJ solicitado apenas para criar o Pix, sem armazenamento no NZN Quiz.
- Boleto continua abrindo a pagina segura do PagBank.

## Render e banco de dados

- Nao e necessario alterar nenhuma variavel de ambiente do Render.
- A conta PagBank usada pelo token precisa ter uma chave Pix ativa.
- As novas colunas do banco sao criadas automaticamente ao iniciar a versao.

## Depois de substituir

1. Envie o novo `server.js` ao GitHub e confirme o commit.
2. Aguarde o Render publicar o commit mais recente.
3. Abra `/health` e confirme a versao `6.8.40`.
4. Teste o Pix com um CPF ou CNPJ valido; o QR Code deve aparecer dentro da plataforma.
5. Teste o boleto; ele deve continuar abrindo o PagBank.
