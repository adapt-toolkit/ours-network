#!/usr/bin/env node
// Local dev broker launcher.
//
// The ADAPT broker is the message relay ours.network nodes connect through. It ships
// as @adapt-toolkit/broker but is not exposed as a published bin, so this is a
// thin launcher over the broker package's public exports — for LOCAL development and
// the test suites only. In production ours-mcp talks to a separately-deployed
// public broker (see OURS_BROKER_URL); the broker is NOT part of this package.
//
// Usage:  node scripts/dev-broker.mjs --host 127.0.0.1 --port 9000 --test_mode
//   --host / --port are REQUIRED (the configurator has no defaults).
//   --test_mode skips attestation checks for local development.

import { Protocol } from '@adapt-toolkit/sdk/wrapper';
import { Broker, BrokerConfigurator } from '@adapt-toolkit/broker';
import { AdaptNetworkComponentConfigurator, logging } from '@adapt-toolkit/sdk/utilities';
import { AdaptEnvironment } from '@adapt-toolkit/sdk/backend';

const broker_configuration = new BrokerConfigurator();
try {
  broker_configuration.process_arguments(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  broker_configuration.display_help();
  process.exit(1);
}

logging.create_logger(broker_configuration.logger_config);

// InitializeAsync (not Initialize) so this works on the WASM backend, whose
// instantiation is inherently async.
AdaptEnvironment.InitializeAsync(AdaptNetworkComponentConfigurator.test_mode)
  .then(() => Protocol.Initialize())
  .then(() => {
    const broker = new Broker(broker_configuration);
    broker.start();
  })
  .catch((e) => {
    console.error('Failed to initialize adapt environment!', e);
    process.exit(1);
  });
