# language: en
Feature: The published Telegram connector exchanges messages with an external API

  Scenario: The connector registers a bot, polls, and answers a chat command
    Given the published Telegram connector is running in its container
    When I register bot "e2e-bot" through the CLI
    Then the registered bot appears in the connector's list
    And the connector authenticates its bot and polls for updates
    When Telegram delivers an id request from chat 7001
    Then the connector sends the chat identifiers back to chat 7001
