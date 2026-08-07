# NZN Quiz 6.8.33 — Apoie o NZN + PagBank

## Novidades
- módulo **Apoie o NZN** para Instrutores e ADM Masters;
- valores rápidos de R$ 5, R$ 10, R$ 20 e R$ 50, além de valor personalizado;
- formas de pagamento via Checkout PagBank: PIX, boleto, cartão de crédito e cartão de débito;
- cada transação recebe um protocolo exclusivo no formato `NZN-AAAAMMDD-XXXXXXXX`;
- histórico dos próprios apoios;
- módulo **Apoios recebidos** exclusivo do ADM Master;
- indicadores de total confirmado, recebido hoje, recebido no mês e pagamentos confirmados;
- webhooks com validação SHA-256 para atualizar os status automaticamente;
- botão para atualizar manualmente o status consultando o Checkout PagBank.

## Variáveis no Render
Adicione no serviço principal do NZN:

```text
PAGBANK_TOKEN=SEU_TOKEN
PAGBANK_ENV=sandbox
```

Durante os testes mantenha `PAGBANK_ENV=sandbox`. Depois da homologação do PagBank, altere para:

```text
PAGBANK_ENV=production
```

Mantenha também `PUBLIC_URL` apontando para o endereço público do NZN para que os webhooks e o retorno do Checkout sejam montados corretamente.

A validação de webhook fica ligada por padrão. Não é necessário criar outra variável. Para diagnóstico temporário existe `PAGBANK_VERIFY_WEBHOOK=false`, mas não é recomendado em produção.

## Cartão de débito
O Checkout PagBank informa que cartão de débito depende de aprovação interna prévia. Caso a conta ainda não tenha essa liberação, o PIX, boleto e crédito continuam disponíveis normalmente.

## Atualização
Substitua `server.js` e `package.json` no GitHub e depois faça no Render:

`Manual Deploy → Clear build cache & deploy`

Confira `/health`: a versão deve ser `6.8.33`.
