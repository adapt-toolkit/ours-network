# language: en
Feature: Two servers exchange data through the local broker

  Scenario Outline: An invitation, messages, and a file travel from <sender> to <receiver>
    Given root identity "<sender>" exists on server <senderServer>
    And root identity "<receiver>" exists on server <receiverServer>
    When "<receiver>" creates a one-time invitation for "<sender>"
    And "<sender>" adds "<receiver>" using the invitation
    And "<sender>" sends "<receiver>" a message
    Then "<receiver>" receives the message and sees it in history
    When "<sender>" sends "<receiver>" a text file named "e2e.txt"
    Then "<receiver>" receives the same bytes and cannot retrieve the file twice
    When "<receiver>" replies to "<sender>"
    Then "<sender>" receives the reply from "<receiver>"

    @server-a-to-b
    Examples: Sender on server A
      | sender | senderServer | receiver | receiverServer |
      | Alice  | A            | Bob      | B              |

    @server-b-to-a
    Examples: Sender on server B
      | sender | senderServer | receiver | receiverServer |
      | Bob    | B            | Alice    | A              |

  @public-invitation
  Scenario Outline: A public invitation can be revoked
    Given root identity "<owner>" exists on server <server>
    Then "<owner>" cannot create a named public invitation for "<contact>"
    And "<owner>" rejects a malformed invitation
    When "<owner>" creates a public invitation
    Then "<owner>" sees the invitation and can revoke it only once

    @server-a
    Examples: Owner on A
      | owner       | server | contact |
      | Alice        | A     | GuestA  |

    @server-b
    Examples: Owner on B
      | owner        | server | contact |
      | Bob          | B      | GuestB  |

  @busy-identity
  Scenario Outline: A second client cannot take a busy identity without explicit force
    Given root identity "<owner>" exists on server <server>
    When two external clients select "<owner>" on server <server>
    Then the second client can take "<owner>" only with explicit force

    @server-a
    Examples: Owner on A
      | owner      | server |
      | Alice       | A    |

    @server-b
    Examples: Owner on B
      | owner       | server |
      | Bob         | B      |

  @server-isolation
  Scenario Outline: Server state is isolated
    Given root identity "<owner>" exists on server <server>
    And root identity "<other>" exists on server <remote>
    Then "<owner>" exists only on server <server> and "<other>" only on server <remote>
    And creating "<owner>" again on server <server> is rejected

    @server-a
    Examples: First identity on A
      | owner           | server | other           | remote |
      | Alice           | A      | Bob             | B      |

    @server-b
    Examples: First identity on B
      | owner           | server | other           | remote |
      | Bob             | B      | Alice           | A      |
