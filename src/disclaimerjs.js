#!/usr/bin/node

require('./index')
  .execute(...process.argv.slice(2))
  .catch(console.error)
