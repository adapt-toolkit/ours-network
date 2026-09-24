# language: en
Feature: Daemon restart preserves committed state
  Scenario: Restarted daemons preserve identities credentials contacts and unread data
    Given both daemons have restarted after committed messages and files
    Then their identities credentials contacts history and file bytes are unchanged
    And the preserved contact can exchange a new encrypted message
