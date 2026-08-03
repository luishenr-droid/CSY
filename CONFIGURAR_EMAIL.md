# Configuração da confirmação de e-mail

No Render, abra **Environment** e adicione:

- `RESEND_API_KEY`: chave criada no painel da Resend.
- `EMAIL_FROM`: remetente autorizado, por exemplo `NZN Quiz <quiz@seudominio.com.br>`.
- `ADMIN_ALLOWED_DOMAIN` (opcional): domínio permitido para novos administradores, por exemplo `credsystem.com.br`.

O domínio usado em `EMAIL_FROM` precisa estar verificado na Resend. Depois de salvar as variáveis, escolha **Save and deploy**.

Sem as duas primeiras variáveis, o botão de cadastro aparece, mas o sistema informa que o envio de confirmação ainda não foi configurado.
