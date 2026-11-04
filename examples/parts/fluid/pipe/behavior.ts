definePart({
  params: {
    fluidSupply: {
      type: 'boolean',
      default: false,
      label: 'Fluid supply',
      desc: 'When enabled, this pipe acts as an infinite fluid supply reservoir for an intake line.',
    },
    openEnd: {
      type: 'boolean',
      default: false,
      label: 'Open discharge end',
      desc: 'When enabled, an unconnected port on this pipe free-flows to atmospheric discharge instead of pressurizing capped.',
    },
  },
  step(ctx) {
    ctx.setFluid({
      fluidSupply: ctx.params.fluidSupply,
      openEnd: ctx.params.openEnd,
    })
  },
})
