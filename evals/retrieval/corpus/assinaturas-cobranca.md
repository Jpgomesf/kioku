---
key: assinaturas-cobranca
title: Cobrança de assinaturas
aliases: [billing-api, subscription billing, cobrança recorrente]
related: [error-codes]
tags: [billing, pagamentos]
confidence: 0.9
---

O serviço billing-api cobra as assinaturas mensalmente pelo Stripe. Quando uma
cobrança falha, novas tentativas acontecem após 3, 5 e 7 dias; depois da
terceira falha a conta passa para o estado suspensa e o cliente recebe um
e-mail.
