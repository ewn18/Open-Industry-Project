definePart({
  params: {
    speed: {
      type: 'number',
      default: 0.0,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Pump speed',
    },
    speedTag: {
      type: 'tag',
      dir: 'in',
      stType: 'REAL',
      default: '',
      label: 'Speed tag (0-1)',
    },
    pressureTag: {
      type: 'tag',
      dir: 'out',
      stType: 'REAL',
      default: '',
      label: 'Discharge pressure tag (PSI)',
    },
    flowTag: {
      type: 'tag',
      dir: 'out',
      stType: 'REAL',
      default: '',
      label: 'Flow rate tag (GPM)',
    },
  },
  step(ctx) {
    const speed = ctx.params.speedTag && ctx.tagDriven(ctx.params.speedTag)
      ? ctx.readNumber(ctx.params.speedTag)
      : ctx.params.speed
    ctx.setFluid({ speed })
    const reading = ctx.fluid()
    if (ctx.params.pressureTag) {
      ctx.writeNumber(ctx.params.pressureTag, reading.pressure)
    }
    if (ctx.params.flowTag) {
      ctx.writeNumber(ctx.params.flowTag, reading.flow)
    }
  },
})
