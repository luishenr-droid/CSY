# Configurar o PagBank

## 1. Obtenha o token de sandbox

Entre no Portal do Desenvolvedor PagBank, abra a aba **Tokens** e copie o token do ambiente Sandbox.

No Render, adicione:

```env
PAGBANK_TOKEN=COLE_SOMENTE_O_TOKEN
PAGBANK_ENV=sandbox
PAGBANK_WEBHOOK_VERIFICATION=auto
PUBLIC_URL=https://SEU-SERVICO.onrender.com
```

Não inclua `Bearer`, aspas ou espaços no valor de `PAGBANK_TOKEN`. A versão 6.8.38 corrige automaticamente esses formatos, mas manter o valor limpo evita erros.

Se existir a variável antiga `PAGBANK_VERIFY_WEBHOOK`, remova-a do Render. A configuração nova `PAGBANK_WEBHOOK_VERIFICATION=auto` substitui essa variável.

## 2. Salve e publique

No Render, use **Save and deploy**. Depois abra:

```text
https://SEU-SERVICO.onrender.com/health
```

O resultado esperado inclui:

```json
{
  "version": "6.8.38",
  "pagbank": {
    "configured": true,
    "environment": "sandbox",
    "webhookVerification": "optional"
  }
}
```

## 3. Teste o checkout

1. Entre no painel administrativo.
2. Abra **Apoie o NZN**.
3. Escolha Pix ou boleto.
4. Use o valor mínimo de R$ 2,00.
5. Confirme se a página segura do PagBank é aberta.
6. Depois do pagamento de teste, atualize o status no painel.

## Erros mais comuns

| Erro | Causa provável | Correção |
| --- | --- | --- |
| 401 | Token inválido ou token de produção usado no sandbox | Gere o token no Portal do Desenvolvedor e mantenha `PAGBANK_ENV=sandbox` |
| 403 | Conta sem permissão para Checkout | Verifique a habilitação da API na conta PagBank |
| 400 com campo | Payload rejeitado | Leia o nome do campo mostrado pela versão 6.8.38 |
| Webhook 401 no sandbox | Assinatura ausente | Use `PAGBANK_WEBHOOK_VERIFICATION=auto` |
| Checkout abre, mas status não atualiza | `PUBLIC_URL` incorreta ou webhook inacessível | Use a URL HTTPS pública do serviço, sem barra final |

## Produção

Depois da homologação do PagBank:

```env
PAGBANK_TOKEN=TOKEN_DE_PRODUCAO
PAGBANK_ENV=production
PAGBANK_WEBHOOK_VERIFICATION=auto
PUBLIC_URL=https://SEU-DOMINIO
```

No modo `auto`, a assinatura é opcional no sandbox e obrigatória em produção.
