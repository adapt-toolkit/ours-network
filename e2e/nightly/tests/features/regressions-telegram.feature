# language: en
@known-bug
Feature: Telegram connector state and delivery regressions

  @withdrawn @preserve-corrupt-bot-registry
  Scenario: A corrupt bot registry is not overwritten
    Given a separate directory contains a corrupt bot registry and a bot provision request
    When I start the connector with that directory
    Then the original corrupt registry remains available for recovery

  @withdrawn @keep-primary-connector-pid
  Scenario: A second serve process does not hide the running connector from CLI status
    Given the primary Telegram connector is already running
    When I start a second serve process with the same state and port
    Then CLI status still identifies the primary connector

  @todo @quote-systemd-state-path
  Scenario: A systemd unit preserves a path with spaces as one value
    Given the Telegram state path contains spaces
    When I install a test systemd unit through the CLI
    Then systemd receives the complete state path as one value

  @todo @avoid-duplicate-telegram-send
  Scenario: A lost Telegram response does not duplicate an outgoing message
    Given Telegram accepts an outgoing POST but drops its response
    When Telegram delivers an id command to the bot
    Then the connector does not resend the same response
