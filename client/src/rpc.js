import url from 'url'
import { Observable as O } from './rxjs'
import { dropErrors, extractErrors, formatError, dbg } from './util'

const INVOICE_TTL = 18000 // 5 hours

// send the 1st tick immediately, randomize the 2nd, then send every `ms`
// (so that requests won't hit the server all at once)
const timer = (ms, val) => O.timer(Math.random()*ms, ms).startWith(-1).mapTo(val)

exports.parseRes = ({ HTTP, SSE }) => {
  const reply = category => dropErrors(HTTP.select(category))

  dbg({ reply$: reply().map(r => [ r.request.category, r.body, r.request ]) }, 'spark:reply')

  return {
    req$$:     HTTP.select()
  , error$:    extractErrors(HTTP.select()).map(formatError)

  // periodic updates
  , info$:     reply('getinfo').map(r => r.body)
  , peers$:    reply('listpeers').map(r => r.body.peers)
  , payments$: reply('listpayments').map(r => r.body.payments)
  , invoices$: reply('listinvoices').map(r => r.body.invoices)

  // replies to actions
  , payreq$:   reply('decodepay').map(r => ({ ...r.body, ...r.request.ctx }))
  , invoice$:  reply('invoice').map(r => ({ ...r.body, ...r.request.ctx }))
  , outgoing$: reply('pay').map(r => ({ ...r.body, ...r.request.ctx }))
  , execRes$:  reply('console').map(r => ({ ...r.request.send, res: r.body }))
  , logs$:     reply('getlog').map(r => ({ ...r.body, log: r.body.log.slice(-200) }))

  // push updates via server-sent events
  , incoming$: SSE('inv-paid')
  , btcusd$:   SSE('btcusd')
  }
}

exports.makeReq = ({ viewPay$, confPay$, newInv$, goLogs$, execRpc$ }) => O.merge(
  viewPay$.map(bolt11 => [ 'decodepay', [ bolt11 ], { bolt11 } ])
, confPay$.map(pay    => [ 'pay',       [ pay.bolt11, ...(pay.custom_msat ? [ pay.custom_msat ] : []) ], pay ])
, newInv$.map(inv     => [ 'invoice',   [ inv.msatoshi, inv.label, inv.description, INVOICE_TTL ], inv ])
, goLogs$.mapTo(         [ 'getlog' ] )

, timer(60000,           [ 'listinvoices', [], { bg: true } ])
, timer(60000,           [ 'listpayments', [], { bg: true } ])
, timer(60000,           [ 'listpeers',    [], { bg: true } ])
, timer(60000,           [ 'getinfo',      [], { bg: true } ])

// also send a "getinfo" ping whenever the window regains focus, to check
// for server connectivity and quickly hide/show the "connection lost" message
// @XXX mobile chrome fails with "ERR_NETWORK_CHANGED" w/o the delay()
, O.fromEvent(window, 'focus').delay(100).mapTo([ 'getinfo', [], { bg: true } ])

, execRpc$.map(([ method, ...params ]) => [ method, params, { category: 'console' }])
)

exports.toHttp = (serverInfo, rpc$) => rpc$.map(([ method, params=[], ctx={} ]) => ({
  category: ctx.category || method
, method: 'POST'
, url: url.resolve(serverInfo.serverUrl, 'rpc')
, send: { method, params }
, headers: { 'X-Requested-With': 'spark-rpc', 'X-Access': serverInfo.accessKey }
, ctx
}))
