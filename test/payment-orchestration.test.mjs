import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentFlows } from '../src/payment.js';

const input = {
  sessionJson: JSON.stringify({ accessToken: 'token', user: { email: 'person@example.com' } }),
  card: { number: '4242424242424242', exp: '12/99', cvc: '123', name: 'Person Test' },
  address: { line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' },
  plan: 'chatgptpro'
};

function fixture(overrides = {}) {
  const calls = [];
  const cg = {
    PLANS: { chatgptpro: { planType: 'pro' } },
    sentinelReq: async opts => {
      calls.push(['sentinel', opts]);
      return { json: { token: 'sentinel-token' } };
    },
    approve: async (_token, _cs, _entity, _sentinel, opts) => {
      calls.push(['approve', opts]);
      return { status: 200, json: { result: 'approved' } };
    },
    getSessionStatus: async (_token, _entity, _cs, opts) => {
      calls.push(['status', opts]);
      return { json: { status: 'open' } };
    },
    cpmConfirm: async () => ({ status: 400, json: {} }),
    cpmStart: async () => ({ status: 400, json: {} }),
    ...overrides.cg
  };
  const stripe = {
    createPM: async (_card, _address, _pk, proxy) => {
      calls.push(['pm', proxy]);
      return { j: { id: 'pm_test' } };
    },
    init: async (_cs, _pk, proxy) => {
      calls.push(['init', proxy]);
      return {
        j: {
          init_checksum: 'checksum',
          invoice: { amount_due: 99900 },
          hosted_url: 'https://checkout.stripe.com/pay/test'
        }
      };
    },
    confirm: async (_cs, _pm, _checksum, _due, _entity, _plan, _pk, proxy) => {
      calls.push(['confirm', proxy]);
      return { j: { status: 'open' } };
    },
    pollSession: async (_cs, _pk, proxy) => {
      calls.push(['poll', proxy]);
      return { j: { payment_status: 'paid' } };
    },
    ...overrides.stripe
  };
  const dependencies = {
    resolveToken: async (_session, opts) => {
      calls.push(['resolve', opts]);
      return { token: 'token', email: 'person@example.com' };
    },
    detectAccountStatus: async (_session, opts) => {
      calls.push(['account', opts]);
      return { state: 'free', plan: 'chatgptfreeplan', errorCode: '' };
    },
    createSession: async (_token, opts) => {
      calls.push(['session', opts]);
      return {
        json: {
          checkout_session_id: 'cs_test',
          publishable_key: 'pk_test',
          processor_entity: 'openai_llc',
          plan_name: 'chatgptpro',
          billing_details: { currency: 'PHP' }
        }
      };
    },
    sleep: async () => {},
    normalizeNetworkContext: value => ({ proxy: value.proxy?.trim() || 'http://fallback.invalid', imp: 'chrome131' }),
    cg,
    stripe,
    ...overrides.dependencies
  };
  return { calls, flows: createPaymentFlows(dependencies) };
}

test('real payment ignores client skipPromo=false and refuses every promotional marker before PM or confirm', async () => {
  for (const marker of [
    'promo_campaign',
    'promo_credit_grant',
    'credit_discount_offer',
    'one_click_trial_eligible',
    'trial',
    'discount'
  ]) {
    const { calls, flows } = fixture({
      dependencies: {
        createSession: async (_token, opts) => {
          calls.push(['session', opts]);
          return {
            json: {
              checkout_session_id: 'cs_promo',
              publishable_key: 'pk_test',
              [marker]: { id: marker }
            }
          };
        }
      }
    });
    await assert.rejects(
      flows.runPay({ ...input, skipPromo: false }, () => {}),
      error => error?.code === 'promotional_offer_attached'
    );
    assert.equal(calls.find(([name]) => name === 'session')[1].skipPromo, true);
    assert.equal(calls.some(([name]) => name === 'pm' || name === 'confirm'), false);
  }
});

test('link generation preserves its existing non-confirming promotional session behavior', async () => {
  const { flows } = fixture({
    dependencies: {
      createSession: async () => ({
        json: {
          checkout_session_id: 'cs_link_promo',
          publishable_key: 'pk_test',
          processor_entity: 'openai_llc',
          promo_campaign: { id: 'promo' }
        }
      })
    }
  });
  const result = await flows.runLink({
    sessionJson: input.sessionJson,
    plan: input.plan
  }, () => {});
  assert.equal(result.short, 'https://chatgpt.com/checkout/openai_llc/cs_link_promo');
});

test('payment-method provider errors remain typed before confirmation starts', async () => {
  const { flows } = fixture({
    stripe: {
      createPM: async () => ({
        j: {
          error: {
            type: 'card_error',
            code: 'invalid_postal_code',
            message: 'postal code mismatch'
          }
        }
      })
    }
  });

  await assert.rejects(
    flows.runPay(input, () => {}),
    error => (
      error?.code === 'invalid_postal_code'
      && error?.providerError?.type === 'card_error'
    )
  );
});

test('real payment reports the normalized account-plan baseline before checkout creation', async () => {
  const events = [];
  const { flows } = fixture({
    dependencies: {
      detectAccountStatus: async () => ({
        state: 'active',
        plan: ' ChatGPTPlus ',
        errorCode: ''
      }),
      createSession: async () => {
        events.push('session');
        return {
          json: {
            checkout_session_id: 'cs_test',
            publishable_key: 'pk_test',
            processor_entity: 'openai_llc',
            plan_name: 'chatgptpro',
            billing_details: { currency: 'PHP' }
          }
        };
      }
    }
  });

  const result = await flows.runPay(input, () => {}, {
    onAccountStatus: value => events.push(value)
  });

  assert.equal(result.state, 'succeeded');
  assert.deepEqual(events, [
    { accountPlanBefore: 'chatgptplusplan' },
    'session'
  ]);
});

test('zero amount is recorded and stops without calling confirm', async () => {
  let amount;
  const { calls, flows } = fixture({
    stripe: {
      init: async () => ({ j: { init_checksum: 'checksum', invoice: { amount_due: 0 } } })
    }
  });
  await assert.rejects(
    flows.runPay(input, () => {}, { onAmount: value => { amount = value; } }),
    error => error?.code === 'zero_amount_offer'
  );
  assert.deepEqual(amount, { amount: 0, currency: 'PHP' });
  assert.equal(calls.some(([name]) => name === 'confirm'), false);
});

test('real payment stops before card setup when checkout plan differs from the selected plan', async () => {
  const { calls, flows } = fixture({
    dependencies: {
      createSession: async (_token, opts) => {
        calls.push(['session', opts]);
        return {
          json: {
            checkout_session_id: 'cs_wrong_plan',
            publishable_key: 'pk_test',
            processor_entity: 'openai_llc',
            plan_name: 'chatgptplusplan',
            billing_details: { currency: 'PHP' }
          }
        };
      }
    }
  });

  await assert.rejects(
    flows.runPay(input, () => {}),
    error => error?.code === 'checkout_plan_mismatch'
  );
  assert.equal(calls.some(([name]) => ['pm', 'init', 'confirm'].includes(name)), false);
});

test('uses the latest pre-confirm invoice amount when the selected plan is unchanged', async () => {
  const amounts = [];
  const confirms = [];
  const { flows } = fixture({
    stripe: {
      init: async () => ({
        j: {
          init_checksum: 'checksum-latest',
          invoice: { amount_due: 98214 },
          hosted_url: 'https://checkout.stripe.com/pay/test'
        }
      }),
      confirm: async (_cs, _pm, checksum, due) => {
        confirms.push({ checksum, due });
        return { j: { status: 'open' } };
      }
    }
  });

  const result = await flows.runPay(input, () => {}, {
    onAmount: value => amounts.push(value)
  });

  assert.deepEqual(amounts, [{ amount: 98214, currency: 'PHP' }]);
  assert.deepEqual(confirms, [{ checksum: 'checksum-latest', due: 98214 }]);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.amount, 98214);
});

test('re-prices and retries confirm once only after an explicit pre-payment invoice mismatch', async () => {
  const amounts = [];
  const confirms = [];
  let initCount = 0;
  const { flows } = fixture({
    stripe: {
      init: async () => {
        initCount += 1;
        const due = initCount === 1 ? 108035 : 98214;
        return {
          j: {
            init_checksum: `checksum-${initCount}`,
            invoice: { amount_due: due },
            hosted_url: 'https://checkout.stripe.com/pay/test'
          }
        };
      },
      confirm: async (_cs, _pm, checksum, due) => {
        confirms.push({ checksum, due });
        if (confirms.length === 1) {
          return {
            j: {
              submission_attempt: {
                state: 'failed',
                error: {
                  code: 'checkout_upcoming_invoice_mismatch',
                  decline_code: null,
                  payment_error: null
                }
              }
            }
          };
        }
        return { j: { status: 'open' } };
      }
    }
  });

  const result = await flows.runPay(input, () => {}, {
    onAmount: value => amounts.push(value)
  });

  assert.deepEqual(amounts, [
    { amount: 108035, currency: 'PHP' },
    { amount: 98214, currency: 'PHP' }
  ]);
  assert.deepEqual(confirms, [
    { checksum: 'checksum-1', due: 108035 },
    { checksum: 'checksum-2', due: 98214 }
  ]);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.amount, 98214);
});

test('waits for invoice amount to change and does not repeat confirm while pricing is stale', async () => {
  let initCount = 0;
  let confirmCount = 0;
  let sleepCount = 0;
  const { flows } = fixture({
    stripe: {
      init: async () => {
        initCount += 1;
        const due = initCount < 4 ? 108035 : 98214;
        return {
          j: {
            init_checksum: `checksum-${initCount}`,
            invoice: { amount_due: due }
          }
        };
      },
      confirm: async () => {
        confirmCount += 1;
        return confirmCount === 1
          ? {
            j: {
              submission_attempt: {
                state: 'failed',
                error: { code: 'checkout_upcoming_invoice_mismatch' }
              }
            }
          }
          : { j: { status: 'open' } };
      }
    },
    dependencies: {
      sleep: async () => { sleepCount += 1; }
    }
  });

  const result = await flows.runPay(input, () => {});
  assert.equal(result.state, 'succeeded');
  assert.equal(result.amount, 98214);
  assert.equal(confirmCount, 2);
  assert.equal(initCount, 4);
  assert.equal(sleepCount, 3);
});

test('does not submit a second confirm when mismatch pricing never changes', async () => {
  let confirmCount = 0;
  let initCount = 0;
  const { flows } = fixture({
    stripe: {
      init: async () => {
        initCount += 1;
        return {
          j: {
            init_checksum: `checksum-${initCount}`,
            invoice: { amount_due: 108035 }
          }
        };
      },
      confirm: async () => {
        confirmCount += 1;
        return {
          j: {
            submission_attempt: {
              state: 'failed',
              error: { code: 'checkout_upcoming_invoice_mismatch' }
            }
          }
        };
      }
    }
  });

  const result = await flows.runPay(input, () => {});
  assert.equal(result.state, 'failed');
  assert.equal(result.error.code, 'checkout_upcoming_invoice_mismatch');
  assert.equal(confirmCount, 1);
  assert.ok(initCount > 1);
});

test('starts PaymentMethod, Stripe init, and Sentinel concurrently after checkout creation', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { flows } = fixture({
    stripe: {
      createPM: async () => {
        started.push('pm');
        await gate;
        return { j: { id: 'pm_test' } };
      },
      init: async () => {
        started.push('init');
        await gate;
        return {
          j: {
            init_checksum: 'checksum',
            invoice: { amount_due: 99900 }
          }
        };
      }
    },
    cg: {
      sentinelReq: async () => {
        started.push('sentinel');
        await gate;
        return { json: { token: 'sentinel-token' } };
      }
    }
  });

  const payment = flows.runPay(input, () => {});
  await new Promise(resolve => setImmediate(resolve));
  const startedBeforeRelease = [...started];
  release();
  await payment;

  assert.deepEqual(new Set(startedBeforeRelease), new Set(['pm', 'init', 'sentinel']));
});

test('polls once immediately after approve before applying any retry delay', async () => {
  const order = [];
  const { flows } = fixture({
    stripe: {
      pollSession: async () => {
        order.push('poll');
        return { j: { payment_status: 'paid' } };
      }
    },
    dependencies: {
      sleep: async () => { order.push('sleep'); }
    }
  });

  const result = await flows.runPay(input, () => {});

  assert.equal(result.state, 'succeeded');
  assert.equal(order[0], 'poll');
  assert.equal(order.includes('sleep'), false);
});

test('uses a trusted fresh account context without resolving or checking the account again', async () => {
  const observed = [];
  const { calls, flows } = fixture();

  const result = await flows.runPay(input, () => {}, {
    accountContext: {
      token: 'cached-token',
      email: 'cached@example.com',
      status: { state: 'free', plan: 'chatgptfreeplan', errorCode: '' }
    },
    onAccountStatus: value => observed.push(value)
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(calls.some(([name]) => name === 'resolve'), false);
  assert.equal(calls.some(([name]) => name === 'account'), false);
  assert.deepEqual(observed, [{ accountPlanBefore: 'chatgptfreeplan' }]);
  assert.equal(calls.find(([name]) => name === 'session')[1].token, undefined);
});

test('does not retry an ambiguous or post-payment confirm response', async () => {
  for (const response of [
    {
      submission_attempt: {
        state: 'failed',
        error: { code: 'api_connection_error' }
      }
    },
    {
      payment_intent: { id: 'pi_created', status: 'processing' },
      submission_attempt: {
        state: 'failed',
        error: { code: 'checkout_upcoming_invoice_mismatch' }
      }
    }
  ]) {
    let confirmCount = 0;
    const { flows } = fixture({
      stripe: {
        confirm: async () => {
          confirmCount += 1;
          return { j: response };
        }
      }
    });

    const result = await flows.runPay(input, () => {});
    assert.equal(result.state, 'unknown');
    assert.equal(confirmCount, 1);
  }
});

test('missing invoice amount does not fall back to total_summary and stops before confirm', async () => {
  const { calls, flows } = fixture({
    stripe: {
      init: async () => ({ j: { init_checksum: 'checksum', total_summary: { due: 99900, total: 99900 } } })
    }
  });
  await assert.rejects(
    flows.runPay(input, () => {}),
    error => error?.code === 'actual_amount_unavailable'
  );
  assert.equal(calls.some(([name]) => name === 'confirm'), false);
});

test('Sentinel preparation finishes before confirm starts and Sentinel failure never calls confirm', async () => {
  {
    const { calls, flows } = fixture();
    await flows.runPay(input, () => {});
    assert.ok(calls.findIndex(([name]) => name === 'sentinel') < calls.findIndex(([name]) => name === 'confirm'));
  }
  {
    const { calls, flows } = fixture({
      cg: {
        sentinelReq: async opts => {
          calls.push(['sentinel', opts]);
          throw Object.assign(new Error('sentinel failed'), { code: 'cloudflare_challenge_failed' });
        }
      }
    });
    await assert.rejects(
      flows.runPay(input, () => {}),
      error => error?.code === 'cloudflare_challenge_failed'
    );
    assert.equal(calls.some(([name]) => name === 'confirm'), false);
  }
});

test('confirm transport exception becomes unknown after confirm_started hook', async () => {
  const stages = [];
  const { flows } = fixture({
    stripe: {
      confirm: async () => {
        assert.deepEqual(stages, ['confirm_started']);
        throw new Error('connection reset');
      }
    }
  });
  const result = await flows.runPay(input, () => {}, { onStage: value => stages.push(value.stage) });
  assert.equal(result.state, 'unknown');
  assert.equal(result.amount, 99900);
  assert.equal(result.currency, 'PHP');
  assert.equal(result.checkoutSessionId, 'cs_test');
});

test('successful payment reports confirm, approve, and polling stages in order', async () => {
  const stages = [];
  const { flows } = fixture();

  const result = await flows.runPay(input, () => {}, {
    onStage: value => stages.push(value.stage)
  });

  assert.equal(result.state, 'succeeded');
  assert.deepEqual(stages, ['confirm_started', 'approve_started', 'polling']);
});

test('approve and poll transport exceptions become unknown without a 12 second wait', async () => {
  for (const overrides of [
    { cg: { approve: async () => { throw new Error('approve reset'); } } },
    { stripe: { pollSession: async () => { throw new Error('poll reset'); } } }
  ]) {
    const { flows } = fixture(overrides);
    const result = await flows.runPay(input, () => {});
    assert.equal(result.state, 'unknown');
    assert.equal(result.checkoutSessionId, 'cs_test');
  }
});

test('poll provider errors fail only for an authoritative payment decline', async () => {
  for (const [error, expected] of [
    [{ type: 'api_connection_error', code: 'api_connection_error' }, 'unknown'],
    [{ type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' }, 'failed']
  ]) {
    const { flows } = fixture({
      stripe: {
        pollSession: async () => ({
          j: { payment_intent: { last_payment_error: error } }
        })
      }
    });
    const result = await flows.runPay(input, () => {});
    assert.equal(result.state, expected);
    if (expected === 'failed') assert.equal(result.final.error, error);
  }
});

test('poll reads a direct submission_attempt error and treats invoice mismatch as explicit failure', async () => {
  const mismatch = {
    code: 'checkout_upcoming_invoice_mismatch',
    decline_code: null,
    payment_error: null
  };
  const { flows } = fixture({
    stripe: {
      pollSession: async () => ({
        j: {
          status: 'open',
          payment_status: 'unpaid',
          submission_attempt: { state: 'failed', error: mismatch }
        }
      })
    }
  });

  const result = await flows.runPay(input, () => {});
  assert.equal(result.state, 'failed');
  assert.equal(result.final.error, mismatch);
});

test('an explicit confirm decline is authoritative failed', async () => {
  const decline = { code: 'card_declined', decline_code: 'insufficient_funds' };
  const { flows } = fixture({
    stripe: { confirm: async () => ({ j: { error: decline } }) }
  });
  const result = await flows.runPay(input, () => {});
  assert.equal(result.state, 'failed');
  assert.equal(result.error, decline);
});

test('a non-payment confirm error is unknown while explicit canceled is failed', async () => {
  {
    const { flows } = fixture({
      stripe: { confirm: async () => ({ j: { error: { code: 'api_connection_error' } } }) }
    });
    assert.equal((await flows.runPay(input, () => {})).state, 'unknown');
  }
  {
    const { calls, flows } = fixture({
      stripe: { confirm: async () => ({ j: { status: 'canceled' } }) }
    });
    assert.equal((await flows.runPay(input, () => {})).state, 'failed');
    assert.equal(calls.some(([name]) => name === 'approve'), false);
  }
});

test('pending 3DS remains pending and does not call approve', async () => {
  const { calls, flows } = fixture({
    stripe: {
      confirm: async () => ({
        j: {
          payment_intent: {
            status: 'requires_action',
            next_action: { redirect_to_url: { url: 'https://verify.example/3ds' } }
          }
        }
      })
    }
  });
  const result = await flows.runPay(input, () => {});
  assert.equal(result.state, 'pending_3ds');
  assert.equal(result.verificationUrl, 'https://verify.example/3ds');
  assert.equal(calls.some(([name]) => name === 'approve'), false);
});

test('authentication_required is never treated as a reusable failed payment', async () => {
  {
    const { calls, flows } = fixture({
      stripe: {
        confirm: async () => ({
          j: {
            error: { type: 'card_error', code: 'authentication_required' },
            payment_intent: {
              status: 'requires_action',
              next_action: { redirect_to_url: { url: 'https://verify.example/auth' } }
            }
          }
        })
      }
    });
    const result = await flows.runPay(input, () => {});
    assert.equal(result.state, 'pending_3ds');
    assert.equal(result.verificationUrl, 'https://verify.example/auth');
    assert.equal(calls.some(([name]) => name === 'approve'), false);
  }
  {
    const { flows } = fixture({
      stripe: {
        confirm: async () => ({
          j: { error: { type: 'card_error', code: 'authentication_required' } }
        })
      }
    });
    assert.equal((await flows.runPay(input, () => {})).state, 'unknown');
  }
});

test('payment and link entrypoints normalize one network context for every dependency', async () => {
  for (const kind of ['pay', 'link']) {
    const { calls, flows } = fixture();
    if (kind === 'pay') {
      await flows.runPay({ ...input, proxy: '   ', imp: 'safari18_0' }, () => {});
    } else {
      await flows.runLink({
        sessionJson: input.sessionJson,
        plan: input.plan,
        proxy: '   ',
        imp: 'safari18_0'
      }, () => {});
    }
    for (const [name, value] of calls) {
      if (['resolve', 'account', 'session', 'sentinel', 'approve', 'status'].includes(name)) {
        assert.equal(value.proxy, 'http://fallback.invalid', `${kind}:${name} proxy`);
        assert.equal(value.imp, 'chrome131', `${kind}:${name} imp`);
      }
      if (['pm', 'init', 'confirm', 'poll'].includes(name)) {
        assert.equal(value, 'http://fallback.invalid', `${kind}:${name} proxy`);
      }
    }
  }
});
