# language: en
Feature: Identity and data isolation through real service boundaries
  Scenario: Temporary ownership cannot be stolen and explicit retirement removes state
    Given two independent SDK sessions on server A with a Human identity
    When the first session creates a temporary identity
    Then the second session cannot bind force-bind delete or close that identity
    When the first session retires its temporary identity
    Then the identity is absent and the second session remains usable

  Scenario: Another identity cannot read a private message or file
    Given private message and file state exists between two servers
    When another identity tries to retrieve that history and file
    Then access is denied and the original recipient still reads the same bytes

  Scenario: Invalid file selections do not consume valid unread files
    Given private message and file state exists between two servers
    When the recipient submits duplicate malformed and mixed unknown file selections
    Then every selection is rejected and the valid file is still unread

  Scenario: Unread batches and history cursors neither lose nor duplicate messages
    Given private message and file state exists between two servers
    When three uniquely identified messages are sent and drained one at a time
    Then each message is observed once and history pagination preserves all three

  Scenario: MCP stdio discovery and identity tools use the configured daemon
    Given two independent SDK sessions on server A with a Human identity
    When the published MCP proxy starts with a private remote profile
    Then MCP discovers tools creates and closes a temporary identity and rejects invalid input
